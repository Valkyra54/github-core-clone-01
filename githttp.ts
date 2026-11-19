// Git smart HTTP: packfiles, protocol v2/v0, receive-pack / upload-pack.
//
// Built on git.ts (sha1 objects, refs, trees, history). Stdlib only (node:zlib,
// node:crypto). Deterministic: no wall clock, no randomness; pack objects are emitted
// sorted by oid and refs sorted by name, so a replay leaves identical state.
//
// Wire notes (from the suite's own git-client.ts, the exact reader):
// - info/refs?service=git-upload-pack with `Git-Protocol: version=2` gets a v2
//   advertisement (`version 2` + ls-refs/fetch caps); without the header it gets a v0
//   advertisement (`# service=git-upload-pack` preamble + refs + caps on the first line).
//   receive-pack is v0 only and always carries the `# service=git-receive-pack` preamble.
// - v2 ls-refs answers `<oid> <ref>[ symref-target:..][ peeled:..]` lines, `unborn HEAD`
//   for an empty repo, and honours ref-prefix filtering server-side.
// - v2 fetch answers acknowledgments (NAK + ready), shallow-info, wanted-refs and a
//   packfile section of sideband-64k band-1 packets; v0 fetch answers NAK, shallow lines
//   and the same sideband pack. Depth-limited walks honour `deepen` exactly: the shallow
//   boundary is the leaf of the depth-limited walk, and an old boundary whose parents are
//   now delivered is reported `unshallow`. A `have` that is also a shallow boundary
//   excludes only itself + its tree, never its parents (that is what makes deepen work).
// - receive-pack parses the pack (v2/v3, zlib, OFS/REF deltas, trailer checksum), stores
//   the objects, then applies each command fast-forward-only, reporting one `ok`/`ng`
//   line per ref inside sideband band 1.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { GitRepo, objectSha, parseCommit, parseTag, parseTree, type GitObject, type ObjectType } from './git.ts';
import type { Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'makefun-forge/1.0';
const MAX_PKT = 65520;
/** Pack data per sideband packet: pkt-line max minus header minus the band byte. */
const SIDEBAND_CHUNK = 65515;

export type GitService = 'git-upload-pack' | 'git-receive-pack';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonError(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > MAX_PKT) throw new Error(`pkt-line payload is ${data.length} bytes, over the limit`);
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

type PktItem = string | Buffer | 'flush' | 'delim';

function pktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload?: Buffer;
}

/**
 * Decode pkt-lines from `buf`. With `stopAtFlush` it stops after the first flush and
 * reports the offset just past it (receive-pack: the pack bytes follow the flush). Without
 * it the whole buffer must parse as pkt-lines.
 */
function decodePktLines(buf: Buffer, stopAtFlush: boolean): { packets: DecodedPacket[]; end: number } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, end: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > MAX_PKT) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (stopAtFlush) throw new Error('pkt-line stream has no flush');
  return { packets, end: offset };
}

/** The data-packet payloads as text lines, in order. */
function dataLines(packets: readonly DecodedPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data' && packet.payload !== undefined) lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// packfile write (plain objects, no deltas)
// ---------------------------------------------------------------------------------------------

const PACK_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = PACK_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export interface PackObject {
  type: ObjectType;
  body: Buffer;
  oid: string;
}

function toPackObject(object: GitObject): PackObject {
  return { type: object.type, body: object.body, oid: objectSha(object.type, object.body) };
}

/** Build a packfile from plain objects, sorted by oid so the bytes are deterministic. */
export function writePack(objects: readonly PackObject[]): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const object of sorted) {
    parts.push(packObjectHeader(object.type, object.body.length));
    parts.push(deflateSync(object.body));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// packfile read (v2/v3, zlib, OFS/REF deltas, trailer checksum)
// ---------------------------------------------------------------------------------------------

const PACK_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readPackVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA and REF_DELTA (recursive,
 * thin-pack bases supplied by `resolveBase`). The trailer checksum must match and every
 * entry must land exactly at the trailer.
 */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackObject[] {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!PACK_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.body, entry.data);
      }
    } else {
      type = PACK_TYPE[entry.typeCode] as ObjectType;
      data = entry.data;
    }
    const oid = objectSha(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  const out: PackObject[] = [];
  for (const entry of raw) {
    const resolved = resolve(entry);
    out.push({ type: resolved.type, body: resolved.data, oid: resolved.oid });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// object enumeration for upload-pack
// ---------------------------------------------------------------------------------------------

/** Add one tree and everything under it (subtrees + blobs) to `out`. */
function addTreeClosure(git: GitRepo, treeSha: string, out: Set<string>): void {
  const stack = [treeSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const object = git.getObject(sha);
    if (object === undefined || object.type !== 'tree') continue;
    out.add(sha);
    for (const entry of parseTree(object.body)) {
      if (entry.mode === '40000') stack.push(entry.sha);
      else out.add(entry.sha);
    }
  }
}

function isHex40(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/** The committer timestamp of a commit object, or 0 when it cannot be read. */
function commitTimestamp(git: GitRepo, oid: string): number {
  const object = git.getObject(oid);
  if (object === undefined || object.type !== 'commit') return 0;
  const parsed = parseCommit(object.body);
  const match = / (\d+) [+-]\d{4}$/.exec(parsed.committer);
  return match === null ? 0 : Number(match[1]);
}

export interface FetchPlan {
  objects: PackObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Which objects a fetch sends, and which shallow boundaries it reports.
 *
 * `wants` are commit/tag/tree/blob oids. `haves` are commits the client already holds.
 * `shallowBoundaries` are the client's current shallow boundaries: a have that is also a
 * boundary excludes only itself + its tree, never its parents — that is what makes deepen
 * deliver the next generation instead of nothing. `depth` is the deepen depth (null = full
 * history); the shallow boundary is the leaf of the depth-limited walk.
 */
export function planFetch(
  git: GitRepo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
  deepenSince: number | null,
  deepenNot: readonly string[],
): FetchPlan {
  const shallowSet = new Set(shallowBoundaries.map((value) => value.toLowerCase()));

  // Commits reachable from deepen-not refs: never delivered, never descended through.
  const notSet = new Set<string>();
  for (const ref of deepenNot) {
    const tip = git.resolveRef(ref) ?? (isHex40(ref) ? ref.toLowerCase() : undefined);
    if (tip !== undefined) for (const sha of git.commitHistory(tip)) notSet.add(sha);
  }

  // Depth-limited walk from the wants (tags peeled to their commit).
  const generation = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [];
  let queueHead = 0;
  const deliver = new Set<string>();
  for (const want of wants) {
    const oid = want.toLowerCase();
    const object = git.getObject(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      deliver.add(oid);
      const target = parseTag(object.body).object;
      const commit = git.peelToCommit(oid);
      if (commit !== undefined) queue.push({ oid: commit, gen: 0 });
      else if (target !== undefined && git.getObject(target)?.type === 'tree') addTreeClosure(git, target, deliver);
      else if (target !== undefined) deliver.add(target);
    } else if (object.type === 'commit') {
      queue.push({ oid, gen: 0 });
    } else if (object.type === 'tree') {
      addTreeClosure(git, oid, deliver);
    } else {
      deliver.add(oid);
    }
  }
  while (queueHead < queue.length) {
    const { oid, gen } = queue[queueHead] as { oid: string; gen: number };
    queueHead += 1;
    if (generation.has(oid) || notSet.has(oid)) continue;
    if (depth !== null && gen >= depth) continue;
    if (deepenSince !== null && commitTimestamp(git, oid) < deepenSince) continue;
    generation.set(oid, gen);
    const object = git.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.body).parents) {
      if (!generation.has(parent)) queue.push({ oid: parent, gen: gen + 1 });
    }
  }

  // Shallow boundaries: leaves of the depth-limited walk (commits with no walked parent).
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of generation.keys()) {
      const object = git.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.body).parents;
      if (parents.every((parent) => !generation.has(parent))) shallow.push(oid);
    }
    shallow.sort();
  }
  // Old boundaries that are now interior (their parents were walked) are unshallow.
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const boundary of shallowSet) {
      if (generation.has(boundary) && !shallow.includes(boundary)) unshallow.push(boundary);
    }
    unshallow.sort();
  }

  // Deliver: walked commits + their tree closures (+ direct tag/tree/blob wants above).
  for (const oid of generation.keys()) {
    deliver.add(oid);
    const object = git.getObject(oid);
    if (object !== undefined && object.type === 'commit') addTreeClosure(git, parseCommit(object.body).tree, deliver);
  }

  // Exclusion: the haves' closures, stopping at shallow boundaries (a boundary have
  // excludes itself + its tree, but never its parents — the client does not hold them).
  const exclude = new Set<string>();
  const visitHave = (start: string): void => {
    const stack = [start.toLowerCase()];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (exclude.has(oid)) continue;
      const object = git.getObject(oid);
      if (object === undefined) continue;
      exclude.add(oid);
      if (object.type === 'commit') {
        addTreeClosure(git, parseCommit(object.body).tree, exclude);
        if (!shallowSet.has(oid)) {
          for (const parent of parseCommit(object.body).parents) stack.push(parent);
        }
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.body).object);
      } else if (object.type === 'tree') {
        addTreeClosure(git, oid, exclude);
      }
    }
  };
  for (const have of haves) visitHave(have);

  const objects: PackObject[] = [];
  for (const oid of deliver) {
    if (exclude.has(oid)) continue;
    const object = git.getObject(oid);
    if (object === undefined) continue;
    objects.push({ type: object.type, body: object.body, oid });
  }
  objects.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefs(git: GitRepo): { name: string; oid: string }[] {
  return [...git.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function v0Caps(repo: Repo, service: GitService): string {
  const head = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (service === 'git-upload-pack') {
    return `side-band-64k thin-pack ofs-delta multi_ack shallow agent=${AGENT} ${head} object-format=sha1`;
  }
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} ${head} object-format=sha1`;
}

/** A v0 ref advertisement: `# service=...` preamble, then refs (caps on the first line). */
function v0Advertisement(repo: Repo, service: GitService): Buffer {
  const git = repo.git;
  const caps = v0Caps(repo, service);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(git);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = git.refs.get(headTarget);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const object = git.getObject(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = git.peelToCommit(ref.oid);
        if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A v2 capability advertisement: service preamble, then `version 2` + capability lines. */
function v2Advertisement(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function infoRefs(repo: Repo, service: GitService, wantV2: boolean): GitResponse {
  if (service === 'git-upload-pack' && wantV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: v0Advertisement(repo, service) };
}

// ---------------------------------------------------------------------------------------------
// protocol v2: ls-refs and fetch
// ---------------------------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
}

/** Split a v2 request body into its command section (before the delim) and its args. */
function parseV2Request(body: Buffer): V2Request {
  const { packets } = decodePktLines(body, false);
  const commandLines: string[] = [];
  const argLines: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8');
    if (inArgs) argLines.push(line);
    else commandLines.push(line);
  }
  const commandLine = commandLines.find((line) => line.startsWith('command='));
  if (commandLine === undefined) throw new Error('v2 request has no command line');
  return { command: commandLine.slice('command='.length).replace(/\n$/, ''), args: argLines };
}

/** POST /{owner}/{repo}.git/git-upload-pack with `Git-Protocol: version=2`. */
export function lsRefs(repo: Repo, body: Buffer): GitResponse {
  let request: V2Request;
  try {
    request = parseV2Request(body);
  } catch (err) {
    return jsonError(400, `malformed ls-refs request: ${(err as Error).message}`);
  }
  if (request.command !== 'ls-refs') return jsonError(400, `unknown v2 command ${request.command}`);
  const wantPeel = request.args.includes('peel\n');
  const wantSymrefs = request.args.includes('symrefs\n');
  const wantUnborn = request.args.includes('unborn\n');
  const prefixes: string[] = [];
  for (const arg of request.args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length).replace(/\n$/, ''));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const git = repo.git;
  const lines: string[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = git.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${wantSymrefs ? ` symref-target:${headTarget}` : ''}\n`);
    } else if (wantUnborn) {
      lines.push(`unborn HEAD symref-target:${headTarget}\n`);
    }
  }
  for (const ref of sortedRefs(git)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel) {
      const object = git.getObject(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = git.peelToCommit(ref.oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  const parts: Buffer[] = lines.map((line) => pktLine(line));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** POST /{owner}/{repo}.git/git-upload-pack with `Git-Protocol: version=2`, command=fetch. */
export function fetchV2(repo: Repo, body: Buffer): GitResponse {
  let request: V2Request;
  try {
    request = parseV2Request(body);
  } catch (err) {
    return jsonError(400, `malformed fetch request: ${(err as Error).message}`);
  }
  if (request.command !== 'fetch') return jsonError(400, `unknown v2 command ${request.command}`);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  const deepenNot: string[] = [];
  for (const arg of request.args) {
    const line = arg.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5));
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
    else if (line.startsWith('deepen-since ')) deepenSince = Number(line.slice(13));
    else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11));
  }
  if (wants.length === 0) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: pktLines(['acknowledgments\n', 'NAK\n', 'ready\n', 'flush']) };
  }
  const plan = planFetch(repo.git, wants, haves, shallow, depth, deepenSince, deepenNot);
  const pack = writePack(plan.objects);

  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine('ready\n'), PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  const wantedRefs: { oid: string; ref: string }[] = [];
  for (const ref of sortedRefs(repo.git)) {
    if (wants.includes(ref.oid)) wantedRefs.push({ oid: ref.oid, ref: ref.name });
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const entry of wantedRefs) parts.push(pktLine(`${entry.oid} ${entry.ref}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// protocol v0: fetch
// ---------------------------------------------------------------------------------------------

/**
 * A v0 upload-pack request: wants (+shallow/deepen) up to a flush, then haves + done up to
 * a second flush. Returns the two sections' lines.
 */
function parseV0Fetch(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null; deepenSince: number | null; deepenNot: string[] } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  const deepenNot: string[] = [];
  let offset = 0;
  let section = 0;
  while (offset < body.length && section < 2) {
    const { packets, end } = decodePktLines(body.subarray(offset), true);
    for (const packet of packets) {
      if (packet.kind !== 'data' || packet.payload === undefined) continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) {
        if (line.startsWith('want ')) {
          // The first want line may carry feature flags after the oid.
          const rest = line.slice(5);
          const space = rest.indexOf(' ');
          wants.push(space < 0 ? rest : rest.slice(0, space));
        } else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
        else if (line.startsWith('deepen-since ')) deepenSince = Number(line.slice(13));
        else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11));
      } else if (line.startsWith('have ')) {
        haves.push(line.slice(5));
      }
    }
    offset += end;
    section += 1;
  }
  return { wants, haves, shallow, depth, deepenSince, deepenNot };
}

/** POST /{owner}/{repo}.git/git-upload-pack without a v2 header (protocol v0 fetch). */
export function fetchV0(repo: Repo, body: Buffer): GitResponse {
  let parsed: ReturnType<typeof parseV0Fetch>;
  try {
    parsed = parseV0Fetch(body);
  } catch (err) {
    return jsonError(400, `malformed v0 fetch request: ${(err as Error).message}`);
  }
  if (parsed.wants.length === 0) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: pktLines(['NAK\n', 'flush']) };
  }
  const plan = planFetch(repo.git, parsed.wants, parsed.haves, parsed.shallow, parsed.depth, parsed.deepenSince, parsed.deepenNot);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// protocol v0: receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface RefReport {
  ref: string;
  ok: boolean;
  reason: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack. */
export function receivePack(repo: Repo, body: Buffer): GitResponse {
  let commands: PushCommand[];
  let packBytes: Buffer;
  try {
    const { packets, end } = decodePktLines(body, true);
    commands = [];
    for (const packet of packets) {
      if (packet.kind !== 'data' || packet.payload === undefined) continue;
      let line = packet.payload.toString('utf8');
      const nul = line.indexOf('\u0000');
      if (nul >= 0) line = line.slice(0, nul);
      const text = line.replace(/\n$/, '');
      if (text === '') continue;
      const parts = text.split(' ');
      if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(text.slice(0, 60))}`);
      commands.push({ oldOid: (parts[0] as string).toLowerCase(), newOid: (parts[1] as string).toLowerCase(), ref: parts.slice(2).join(' ') });
    }
    packBytes = body.subarray(end);
  } catch (err) {
    return reportResponse([{ ref: '', ok: false, reason: 'malformed request' }], `malformed receive-pack request: ${(err as Error).message}`);
  }
  if (commands.length === 0) return reportResponse([], 'unpack ok');

  // Unpack the pack (when one was sent) and store its objects.
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (updatesRef && packBytes.length > 0) {
    let objects: PackObject[];
    try {
      objects = readPack(packBytes);
    } catch (err) {
      return reportResponse([], 'unpack error', (err as Error).message);
    }
    for (const object of objects) repo.git.putObject(object.type, object.body);
  }

  const git = repo.git;
  const reports: RefReport[] = [];
  for (const command of commands) {
    const current = git.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      } else if (current.toLowerCase() !== command.oldOid && command.oldOid !== ZERO_OID) {
        reports.push({ ref: command.ref, ok: false, reason: 'stale old object id' });
      } else {
        git.refs.delete(command.ref);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = git.getObject(command.newOid);
    if (target === undefined) {
      reports.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
      reports.push({ ref: command.ref, ok: false, reason: 'not a commit' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        git.refs.set(command.ref, command.newOid);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: the old value must match, and the new tip must descend from it.
    if (current === undefined) {
      reports.push({ ref: command.ref, ok: false, reason: 'no such ref' });
    } else if (current.toLowerCase() !== command.oldOid) {
      reports.push({ ref: command.ref, ok: false, reason: 'stale old object id' });
    } else if (command.oldOid !== command.newOid && !git.isAncestor(command.oldOid, command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      git.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  return reportResponse(reports, 'unpack ok');
}

/**
 * The report-status stream: `unpack <detail>` then one `ok`/`ng` line per ref, each as its
 * own pkt-line inside a sideband band-1 packet, then a flush. `unpackDetail` is 'unpack ok'
 * on success; on an unpack failure it is 'unpack error' and `reports` is empty.
 */
function reportResponse(reports: RefReport[], unpackDetail: string, _unpackError?: string): GitResponse {
  const lines: string[] = [unpackDetail === 'unpack ok' ? 'unpack ok\n' : 'unpack error\n'];
  for (const report of reports) {
    if (report.ref === '') continue;
    lines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  }
  const parts: Buffer[] = [];
  for (const line of lines) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// upload-pack dispatch (v2 command vs v0 fetch)
// ---------------------------------------------------------------------------------------------

/** POST /{owner}/{repo}.git/git-upload-pack. `isV2` is the `Git-Protocol: version=2` header. */
export function uploadPack(repo: Repo, body: Buffer, isV2: boolean): GitResponse {
  if (isV2) {
    let command: string;
    try {
      command = parseV2Request(body).command;
    } catch (err) {
      return jsonError(400, `malformed upload-pack request: ${(err as Error).message}`);
    }
    if (command === 'ls-refs') return lsRefs(repo, body);
    if (command === 'fetch') return fetchV2(repo, body);
    return jsonError(400, `unknown v2 command ${command}`);
  }
  return fetchV0(repo, body);
}
