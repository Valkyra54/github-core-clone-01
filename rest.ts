// The REST v3 handlers: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, on top of the store. Every handler returns a Response;
// app.ts turns it into JSON with the protocol headers.
//
// Contract notes (from the sealed checks, program/env/src/checks-rest.ts):
// - PUT /contents creates a real commit on the named branch (or the default branch), so
//   the git checks later see it; an unborn repository accepts the first commit.
// - A repo under another owner is 404, never 403; a missing token is 401 (app.ts).
// - POST /user/repos for an existing name is 422 (the pagination check relies on it).
// - A merge is a squash onto the base branch by default; a conflicted merge is 405.

import { diffLines, parseCommit, splitLines } from './git.ts';
import {
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  VIEWER_NAME,
  commentJson,
  issueJson,
  labelJson,
  nowEpochSeconds,
  nowIso,
  pullJson,
  repoJson,
  viewerUser,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RequestContext {
  method: string;
  /** Decoded path segments after `/api/v3` (empty for the root). */
  segments: string[];
  /** The request path as sent, without the query string (for Link headers). */
  pathname: string;
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there was no body. */
  body: unknown;
  /** The request Host header, for absolute Link URLs. */
  host: string;
}

export interface Response {
  status: number;
  /** JSON body; undefined sends no body (204). */
  body?: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => ({ status, body, headers });
const noContent = (): Response => ({ status: 204 });
const notFound = (message = 'Not Found'): Response => json(404, { message });
const badRequest = (message: string): Response => json(400, { message });
const unprocessable = (message: string): Response => json(422, { message });
const conflict = (message: string): Response => json(409, { message });
const methodNotAllowed = (message: string): Response => json(405, { message });

function asObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** The repository a route names, or a 404 Response when it is not this token's to see. */
function repoOr404(store: Store, owner: string, name: string): Repo | Response {
  if (owner !== VIEWER_LOGIN) return notFound('Not Found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return notFound('Not Found');
  return repo;
}

function isResponse(value: Repo | Response): value is Response {
  return (value as Response).status !== undefined;
}

/** Page a list (GitHub defaults: per_page 30, page 1) and build the Link header. */
function paginate<T>(items: readonly T[], ctx: RequestContext): { page: T[]; link: string | null } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.floor(perPageRaw))) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (target: number): string => `http://${ctx.host}${ctx.pathname}?per_page=${perPage}&page=${target}`;
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  return { page: [...slice], link: links.length > 0 ? links.join(', ') : null };
}

function linkHeader(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

/** Commit one contents change on a branch and return the new commit sha. */
function commitContents(
  repo: Repo,
  branch: string,
  files: Map<string, string>,
  message: string,
): string {
  const treeSha = repo.git.buildTree(files);
  const tip = repo.git.refs.get(`refs/heads/${branch}`);
  const parents = tip === undefined ? [] : [tip];
  const commitSha = repo.git.createCommit(treeSha, parents, message, nowEpochSeconds(), `${VIEWER_NAME} <${VIEWER_EMAIL}>`);
  repo.git.refs.set(`refs/heads/${branch}`, commitSha);
  return commitSha;
}

/** The flat file map of a branch tip (or an empty map for an unborn branch). */
function branchFiles(repo: Repo, branch: string): Map<string, string> | null {
  const tip = repo.git.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return null;
  const object = repo.git.getObject(tip);
  if (object === undefined || object.type !== 'commit') return null;
  const files = repo.git.flattenTree(parseCommit(object.body).tree);
  return files ?? new Map<string, string>();
}

/** Resolve a ref query (?ref=) to a commit sha: branch name, full ref, or commit sha. */
function resolveRefParam(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return repo.git.refs.get(`refs/heads/${repo.defaultBranch}`);
  return repo.git.resolveRef(ref);
}

// ---------------------------------------------------------------------------------------------
// Repositories

export function createUserRepo(store: Store, ctx: RequestContext): Response {
  const body = asObject(ctx.body);
  const name = body === null ? undefined : asString(body.name);
  if (name === undefined || name === '') return unprocessable('name is required');
  const isPrivate = body === null ? false : (asBoolean(body.private) ?? false);
  const description = body === null ? '' : (asString(body.description) ?? '');
  const defaultBranch = body === null ? 'main' : (asString(body.default_branch) ?? 'main');
  const repo = store.createRepo(VIEWER_LOGIN, name, isPrivate, description, defaultBranch);
  if (repo === null) return unprocessable(`Repository ${VIEWER_LOGIN}/${name} already exists`);
  return json(201, repoJson(repo));
}

export function listUserRepos(store: Store, ctx: RequestContext): Response {
  const repos = store.listRepos(VIEWER_LOGIN);
  const { page, link } = paginate(repos, ctx);
  return json(200, page.map(repoJson), linkHeader(link));
}

export function getRepo(store: Store, owner: string, name: string): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  return json(200, repoJson(repo));
}

export function patchRepo(store: Store, owner: string, name: string, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const body = asObject(ctx.body);
  if (body !== null) {
    const description = asString(body.description);
    if (description !== undefined) repo.description = description;
    const isPrivate = asBoolean(body.private);
    if (isPrivate !== undefined) repo.isPrivate = isPrivate;
    repo.updatedAt = nowIso();
  }
  return json(200, repoJson(repo));
}

export function deleteRepo(store: Store, owner: string, name: string): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  store.deleteRepo(owner, name);
  return noContent();
}

// ---------------------------------------------------------------------------------------------
// Branches, refs, commits

export function createRef(store: Store, owner: string, name: string, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const body = asObject(ctx.body);
  const ref = body === null ? undefined : asString(body.ref);
  const sha = body === null ? undefined : asString(body.sha);
  if (ref === undefined || sha === undefined) return unprocessable('ref and sha are required');
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return unprocessable(`unsupported ref ${ref}`);
  const object = repo.git.getObject(sha.toLowerCase());
  if (object === undefined || (ref.startsWith('refs/heads/') && object.type !== 'commit')) {
    return unprocessable(`sha ${sha} does not exist`);
  }
  if (repo.git.refs.has(ref)) return unprocessable(`ref ${ref} already exists`);
  repo.git.refs.set(ref, sha.toLowerCase());
  return json(201, { ref, object: { sha: sha.toLowerCase(), type: object.type, url: `/api/v3/repos/${repo.fullName}/git/${object.type}s/${sha.toLowerCase()}` } });
}

export function getRef(store: Store, owner: string, name: string, refPath: string): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const ref = `refs/${refPath}`;
  const sha = repo.git.refs.get(ref);
  if (sha === undefined) return notFound('Not Found');
  const object = repo.git.getObject(sha);
  return json(200, { ref, object: { sha, type: object?.type ?? 'commit', url: `/api/v3/repos/${repo.fullName}/git/${object?.type ?? 'commit'}s/${sha}` } });
}

export function listBranches(store: Store, owner: string, name: string): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const branches: { name: string; commit: { sha: string } }[] = [];
  for (const [ref, sha] of [...repo.git.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
  }
  return json(200, branches);
}

export function getBranch(store: Store, owner: string, name: string, branch: string): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const sha = repo.git.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return notFound('Not Found');
  return json(200, { name: branch, commit: { sha } });
}

export function listCommits(store: Store, owner: string, name: string, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const ref = ctx.query.get('sha');
  const tip = ref === null ? repo.git.refs.get(`refs/heads/${repo.defaultBranch}`) : repo.git.resolveRef(ref);
  if (tip === undefined) return notFound('Not Found');
  const commits = repo.git.commitHistory(tip).map((sha) => {
    const object = repo.git.getObject(sha);
    const parsed = object === undefined ? null : parseCommit(object.body);
    return {
      sha,
      commit: {
        message: parsed?.message ?? '',
        author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: nowIso() },
        committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: nowIso() },
        tree: { sha: parsed?.tree ?? '' },
      },
      author: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
      committer: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
      parents: (parsed?.parents ?? []).map((parent) => ({ sha: parent })),
    };
  });
  return json(200, commits);
}

// ---------------------------------------------------------------------------------------------
// Contents

export function putContent(store: Store, owner: string, name: string, filePath: string, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const body = asObject(ctx.body);
  if (body === null) return badRequest('a JSON body is required');
  const message = asString(body.message) ?? `Update ${filePath}`;
  const contentB64 = asString(body.content);
  if (contentB64 === undefined) return unprocessable('content is required');
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const givenSha = asString(body.sha);
  let files = branchFiles(repo, branch);
  if (files === null) {
    // An unborn repository accepts its first commit on the default branch.
    if (repo.git.refs.size === 0 && branch === repo.defaultBranch) files = new Map<string, string>();
    else return notFound(`branch ${branch} does not exist`);
  }
  const existingSha = files.get(filePath);
  let status = 201;
  if (existingSha !== undefined) {
    if (givenSha === undefined) return unprocessable('sha is required to update a file');
    if (givenSha.toLowerCase() !== existingSha.toLowerCase()) return conflict('sha does not match the current blob');
    status = 200;
  }
  const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobSha = repo.git.createBlob(bytes);
  files.set(filePath, blobSha);
  const commitSha = commitContents(repo, branch, files, message);
  return json(status, {
    content: {
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      sha: blobSha,
      size: bytes.length,
      type: 'file',
      content: contentB64,
      encoding: 'base64',
    },
    commit: { sha: commitSha, message },
  });
}

export function getContent(store: Store, owner: string, name: string, filePath: string, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const tip = resolveRefParam(repo, ctx.query.get('ref'));
  if (tip === undefined) return notFound('Not Found');
  const object = repo.git.getObject(tip);
  if (object === undefined || object.type !== 'commit') return notFound('Not Found');
  const treeSha = parseCommit(object.body).tree;
  if (filePath === '') {
    const entries = repo.git.listDir(treeSha, '');
    if (entries === undefined) return notFound('Not Found');
    return json(200, entries.map((entry) => dirEntryJson(repo, entry)));
  }
  const blobSha = repo.git.fileAt(treeSha, filePath);
  if (blobSha !== undefined) {
    const blob = repo.git.getObject(blobSha);
    const bytes = blob === undefined ? Buffer.alloc(0) : blob.body;
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: bytes.length,
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      sha: blobSha,
      content: bytes.toString('base64'),
    });
  }
  const entries = repo.git.listDir(treeSha, filePath);
  if (entries === undefined) return notFound('Not Found');
  return json(200, entries.map((entry) => dirEntryJson(repo, entry)));
}

function dirEntryJson(
  repo: Repo,
  entry: { name: string; path: string; type: 'file' | 'dir'; sha: string },
): Record<string, unknown> {
  return {
    type: entry.type,
    size: entry.type === 'file' ? (repo.git.getObject(entry.sha)?.body.length ?? 0) : 0,
    name: entry.name,
    path: entry.path,
    sha: entry.sha,
    url: `/api/v3/repos/${repo.fullName}/contents/${entry.path}`,
    html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${entry.path}`,
  };
}

export function deleteContent(store: Store, owner: string, name: string, filePath: string, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const body = asObject(ctx.body);
  const message = body === null ? `Delete ${filePath}` : (asString(body.message) ?? `Delete ${filePath}`);
  const givenSha = body === null ? undefined : asString(body.sha);
  const branch = body === null ? repo.defaultBranch : (asString(body.branch) ?? repo.defaultBranch);
  const files = branchFiles(repo, branch);
  if (files === null) return notFound(`branch ${branch} does not exist`);
  const existingSha = files.get(filePath);
  if (existingSha === undefined) return notFound('Not Found');
  if (givenSha !== undefined && givenSha.toLowerCase() !== existingSha.toLowerCase()) return conflict('sha does not match the current blob');
  files.delete(filePath);
  const commitSha = commitContents(repo, branch, files, message);
  return json(200, { commit: { sha: commitSha, message } });
}

// ---------------------------------------------------------------------------------------------
// Labels

export function createLabel(store: Store, owner: string, name: string, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const body = asObject(ctx.body);
  const labelName = body === null ? undefined : asString(body.name);
  if (labelName === undefined || labelName === '') return unprocessable('name is required');
  const existing = repo.labels.get(labelName);
  if (existing !== undefined) return json(201, labelJson(existing));
  const label: Label = {
    name: labelName,
    color: body === null ? 'ededed' : (asString(body.color) ?? 'ededed'),
    description: body === null ? '' : (asString(body.description) ?? ''),
  };
  repo.labels.set(labelName, label);
  return json(201, labelJson(label));
}

export function listLabels(store: Store, owner: string, name: string): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  return json(200, [...repo.labels.values()].map(labelJson));
}

// ---------------------------------------------------------------------------------------------
// Issues and comments

export function createIssue(store: Store, owner: string, name: string, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const body = asObject(ctx.body);
  const title = body === null ? undefined : asString(body.title);
  if (title === undefined || title === '') return unprocessable('title is required');
  const labelsRaw = body === null ? undefined : body.labels;
  const labelNames: string[] = Array.isArray(labelsRaw) ? labelsRaw.filter((item): item is string => typeof item === 'string') : [];
  const labels: Label[] = [];
  for (const labelName of labelNames) {
    const label = repo.labels.get(labelName);
    if (label === undefined) return unprocessable(`label ${labelName} does not exist`);
    labels.push(label);
  }
  const now = nowIso();
  const issue: Issue = {
    id: store.nextGlobal(),
    number: repo.nextNumber,
    title,
    body: body === null ? '' : (asString(body.body) ?? ''),
    state: 'open',
    labels,
    user: viewerUser(),
    createdAt: now,
    updatedAt: now,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return json(201, issueJson(issue, repo));
}

export function listIssues(store: Store, owner: string, name: string, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') return unprocessable(`unknown state ${state}`);
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const { page, link } = paginate(issues, ctx);
  return json(200, page.map((issue) => issueJson(issue, repo)), linkHeader(link));
}

export function getIssue(store: Store, owner: string, name: string, number: number): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound('Not Found');
  return json(200, issueJson(issue, repo));
}

export function patchIssue(store: Store, owner: string, name: string, number: number, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound('Not Found');
  const body = asObject(ctx.body);
  if (body !== null) {
    const state = asString(body.state);
    if (state !== undefined) {
      if (state !== 'open' && state !== 'closed') return unprocessable(`unknown state ${state}`);
      issue.state = state;
    }
    const title = asString(body.title);
    if (title !== undefined) issue.title = title;
    const text = asString(body.body);
    if (text !== undefined) issue.body = text;
    issue.updatedAt = nowIso();
  }
  return json(200, issueJson(issue, repo));
}

export function createComment(store: Store, owner: string, name: string, number: number, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound('Not Found');
  const body = asObject(ctx.body);
  const text = body === null ? undefined : asString(body.body);
  if (text === undefined) return unprocessable('body is required');
  const now = nowIso();
  const comment: Comment = { id: repo.nextCommentId, body: text, user: viewerUser(), createdAt: now, updatedAt: now };
  repo.nextCommentId += 1;
  issue.comments.push(comment);
  return json(201, commentJson(comment, repo, number));
}

export function listComments(store: Store, owner: string, name: string, number: number): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound('Not Found');
  return json(200, issue.comments.map((comment) => commentJson(comment, repo, number)));
}

// ---------------------------------------------------------------------------------------------
// Pull requests

export function createPull(store: Store, owner: string, name: string, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const body = asObject(ctx.body);
  const headRef = body === null ? undefined : asString(body.head);
  const baseRef = body === null ? undefined : asString(body.base);
  const title = body === null ? undefined : asString(body.title);
  if (headRef === undefined || baseRef === undefined) return unprocessable('head and base are required');
  if (title === undefined || title === '') return unprocessable('title is required');
  const headSha = repo.git.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.git.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined) return unprocessable(`head branch ${headRef} does not exist`);
  if (baseSha === undefined) return unprocessable(`base branch ${baseRef} does not exist`);
  const now = nowIso();
  const pull: Pull = {
    id: store.nextGlobal(),
    number: repo.nextNumber,
    title,
    body: body === null ? '' : (asString(body.body) ?? ''),
    state: 'open',
    headRef,
    headSha,
    baseRef,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    user: viewerUser(),
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return json(201, pullJson(pull, repo));
}

export function listPulls(store: Store, owner: string, name: string, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') return unprocessable(`unknown state ${state}`);
  pulls.sort((a, b) => b.number - a.number);
  const { page, link } = paginate(pulls, ctx);
  return json(200, page.map((pull) => pullJson(pull, repo)), linkHeader(link));
}

export function getPull(store: Store, owner: string, name: string, number: number): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound('Not Found');
  return json(200, pullJson(pull, repo));
}

/** The changed files between a base tree and a head tree, with line counts. */
export function pullFiles(store: Store, owner: string, name: string, number: number): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound('Not Found');
  const baseTip = repo.git.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.git.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return notFound('Not Found');
  const baseCommit = repo.git.getObject(baseTip);
  const headCommit = repo.git.getObject(headTip);
  if (baseCommit === undefined || headCommit === undefined) return notFound('Not Found');
  const baseFiles = repo.git.flattenTree(parseCommit(baseCommit.body).tree) ?? new Map<string, string>();
  const headFiles = repo.git.flattenTree(parseCommit(headCommit.body).tree) ?? new Map<string, string>();
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const baseSha = baseFiles.get(path);
    const headSha = headFiles.get(path);
    if (baseSha === headSha) continue;
    if (baseSha === undefined && headSha !== undefined) {
      const bytes = repo.git.getObject(headSha)?.body ?? Buffer.alloc(0);
      const additions = splitLines(bytes.toString('utf8')).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (headSha === undefined && baseSha !== undefined) {
      const bytes = repo.git.getObject(baseSha)?.body ?? Buffer.alloc(0);
      const deletions = splitLines(bytes.toString('utf8')).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (baseSha !== undefined && headSha !== undefined) {
      const oldText = (repo.git.getObject(baseSha)?.body ?? Buffer.alloc(0)).toString('utf8');
      const newText = (repo.git.getObject(headSha)?.body ?? Buffer.alloc(0)).toString('utf8');
      const { additions, deletions } = diffLines(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return json(200, out);
}

export function mergePull(store: Store, owner: string, name: string, number: number, ctx: RequestContext): Response {
  const repo = repoOr404(store, owner, name);
  if (isResponse(repo)) return repo;
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound('Not Found');
  if (pull.merged) return methodNotAllowed('pull request is already merged');
  const baseTip = repo.git.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.git.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return notFound('Not Found');
  const baseCommit = repo.git.getObject(baseTip);
  const headCommit = repo.git.getObject(headTip);
  if (baseCommit === undefined || headCommit === undefined) return notFound('Not Found');
  const baseTree = parseCommit(baseCommit.body).tree;
  const headTree = parseCommit(headCommit.body).tree;
  const mergeBase = repo.git.mergeBase(headTip, baseTip);
  if (mergeBase !== undefined) {
    const baseObject = repo.git.getObject(mergeBase);
    if (baseObject !== undefined) {
      const ancestorTree = parseCommit(baseObject.body).tree;
      const ancestorFiles = repo.git.flattenTree(ancestorTree) ?? new Map<string, string>();
      const baseFiles = repo.git.flattenTree(baseTree) ?? new Map<string, string>();
      const headFiles = repo.git.flattenTree(headTree) ?? new Map<string, string>();
      const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
      for (const path of paths) {
        const ancestorSha = ancestorFiles.get(path);
        const baseSha = baseFiles.get(path);
        const headSha = headFiles.get(path);
        const baseChanged = baseSha !== ancestorSha;
        const headChanged = headSha !== ancestorSha;
        if (baseChanged && headChanged && baseSha !== headSha) {
          return methodNotAllowed(`merge conflict: ${path} changed on both sides`);
        }
      }
    }
  }
  const body = asObject(ctx.body);
  const method = body === null ? 'squash' : (asString(body.merge_method) ?? 'squash');
  const message = `Merge pull request #${number} from ${repo.owner}/${pull.headRef}`;
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const mergeSha = repo.git.createCommit(headTree, parents, message, nowEpochSeconds(), `${VIEWER_NAME} <${VIEWER_EMAIL}>`);
  repo.git.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  pull.updatedAt = nowIso();
  return json(200, { sha: mergeSha, merged: true, message });
}
