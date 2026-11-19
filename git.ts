// The git object store: sha1 blob/tree/commit objects, refs, tree building and reading,
// ancestry walks and merge-base, line diffs. One store per repository, all in memory.
//
// Everything here is deterministic: object ids are sha1s of content, commit timestamps come
// from the trial's fixed now (never the wall clock), and every enumeration is sorted.

import { createHash } from 'node:crypto';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  /** The raw object body, without the "<type> <len>\0" header. */
  body: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** The sha1 of one git object: sha1("<type> <len>\0" + body). */
export function objectSha(type: ObjectType, body: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

/** The empty tree's sha, for reference: sha1("tree 0\0"). */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Git's tree sort: entries by name, directories compared as if the name ended with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = treeSortKey(a);
  const kb = treeSortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Parse one tree object's body into its entries (in stored order). */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const nul = body.indexOf(0x00, space + 1);
    if (space === -1 || nul === -1) break;
    const mode = body.subarray(offset, space).toString('utf8');
    const name = body.subarray(space + 1, nul).toString('utf8');
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Serialise tree entries (already sorted) into a tree body. */
function serialiseTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse one commit object's body: tree, parents, author, committer, message. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(body: Buffer): ParsedCommit {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2).replace(/\n$/, '');
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialise a commit body from its fields. */
export function serialiseCommit(commit: ParsedCommit): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}\n`, 'utf8');
}

/** Parse an annotated tag object's body: object, type, tag name, tagger, message. */
export interface ParsedTag {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(body: Buffer): ParsedTag {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2).replace(/\n$/, '');
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** One repository's objects and refs. */
export class GitRepo {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();

  putObject(type: ObjectType, body: Buffer): string {
    const sha = objectSha(type, body);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, body });
    return sha;
  }

  getObject(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  hasObject(sha: string): boolean {
    return this.objects.has(sha);
  }

  createBlob(bytes: Buffer): string {
    return this.putObject('blob', bytes);
  }

  /**
   * Build the tree for a flat file map (path -> blob sha), bottom-up, and return the root
   * tree sha. An empty map builds the empty tree.
   */
  buildTree(files: ReadonlyMap<string, string>): string {
    const build = (entries: ReadonlyMap<string, string>): string => {
      const dirs = new Map<string, Map<string, string>>();
      const treeEntries: TreeEntry[] = [];
      for (const [path, sha] of entries) {
        const slash = path.indexOf('/');
        if (slash === -1) {
          treeEntries.push({ mode: '100644', name: path, sha });
        } else {
          const dir = path.slice(0, slash);
          let sub = dirs.get(dir);
          if (sub === undefined) {
            sub = new Map<string, string>();
            dirs.set(dir, sub);
          }
          sub.set(path.slice(slash + 1), sha);
        }
      }
      for (const [dir, sub] of dirs) {
        treeEntries.push({ mode: '40000', name: dir, sha: build(sub) });
      }
      treeEntries.sort(compareTreeEntries);
      return this.putObject('tree', serialiseTree(treeEntries));
    };
    return build(files);
  }

  /** The flat file map (path -> blob sha) of one tree, or undefined when the tree is missing. */
  flattenTree(treeSha: string): Map<string, string> | undefined {
    const out = new Map<string, string>();
    const walk = (sha: string, prefix: string): boolean => {
      const object = this.objects.get(sha);
      if (object === undefined || object.type !== 'tree') return false;
      for (const entry of parseTree(object.body)) {
        if (entry.mode === '40000') {
          if (!walk(entry.sha, `${prefix}${entry.name}/`)) return false;
        } else {
          out.set(`${prefix}${entry.name}`, entry.sha);
        }
      }
      return true;
    };
    return walk(treeSha, '') ? out : undefined;
  }

  /**
   * The immediate children of one directory inside a tree: files and subdirectories, each
   * with its path relative to the repository root. `dirPath` is '' for the root.
   */
  listDir(treeSha: string, dirPath: string): { name: string; path: string; type: 'file' | 'dir'; sha: string }[] | undefined {
    let current = treeSha;
    if (dirPath !== '') {
      for (const segment of dirPath.split('/')) {
        const object = this.objects.get(current);
        if (object === undefined || object.type !== 'tree') return undefined;
        const entry = parseTree(object.body).find((item) => item.name === segment && item.mode === '40000');
        if (entry === undefined) return undefined;
        current = entry.sha;
      }
    }
    const object = this.objects.get(current);
    if (object === undefined || object.type !== 'tree') return undefined;
    return parseTree(object.body).map((entry) => ({
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      sha: entry.sha,
    }));
  }

  /** The blob sha of one file inside a tree, or undefined when the path is not a file. */
  fileAt(treeSha: string, filePath: string): string | undefined {
    const files = this.flattenTree(treeSha);
    return files?.get(filePath);
  }

  /**
   * Resolve a ref to a commit sha: a full ref ('refs/heads/main'), a bare branch name, or a
   * 40-hex commit sha. Returns undefined when it names nothing (or a non-commit object).
   */
  resolveRef(ref: string): string | undefined {
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      const object = this.objects.get(ref.toLowerCase());
      return object !== undefined && object.type === 'commit' ? ref.toLowerCase() : undefined;
    }
    if (ref.startsWith('refs/')) return this.refs.get(ref);
    return this.refs.get(`refs/heads/${ref}`);
  }

  /** Create a commit object and return its sha. */
  createCommit(tree: string, parents: readonly string[], message: string, epochSeconds: number, author: string): string {
    const stamp = `${epochSeconds} +0000`;
    const identity = `${author} ${stamp}`;
    return this.putObject(
      'commit',
      serialiseCommit({ tree, parents: [...parents], author: identity, committer: identity, message }),
    );
  }

  /** The commit shas reachable from a tip, newest first (tip, then parents, deduplicated). */
  commitHistory(tip: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = this.objects.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(sha);
      const parsed = parseCommit(object.body);
      // Push parents in reverse so the first parent is visited first.
      for (let index = parsed.parents.length - 1; index >= 0; index -= 1) {
        stack.push(parsed.parents[index] as string);
      }
    }
    return out;
  }

  /** True when `ancestor` is reachable from `descendant` (or the two are equal). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.commitHistory(descendant).includes(ancestor);
  }

  /** The first common ancestor of two tips when walking back from both, or undefined. */
  mergeBase(a: string, b: string): string | undefined {
    const ancestorsOfA = new Set(this.commitHistory(a));
    for (const sha of this.commitHistory(b)) {
      if (ancestorsOfA.has(sha)) return sha;
    }
    return undefined;
  }

  /**
   * Follow tag objects to the commit they point at (or undefined when the chain does not
   * end in a commit). Used for peeling annotated tags in advertisements and ls-refs.
   */
  peelToCommit(oid: string): string | undefined {
    let current = oid.toLowerCase();
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.body).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }
}

/** Split text into lines the way a diff counts them (a trailing newline ends the last line). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * A small line diff by common prefix/suffix: additions and deletions for one file changing
 * from `oldText` to `newText`. Exact for single-hunk changes, which is all the suite sends.
 */
export function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { additions: newLines.length - prefix - suffix, deletions: oldLines.length - prefix - suffix };
}
