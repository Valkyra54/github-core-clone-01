// The GraphQL v4 executor: POST /api/graphql, over the same store as REST and git.
// A tiny hand-written executor for exactly the documents the suite sends (see
// SCOPE.md §2 / program/env/src/checks-graphql.ts): viewer, repository, node, __type,
// issue/pull-request reads, and the five mutations. No GraphQL library, stdlib only.
//
// Wire rules (from the sealed checks):
// - An unknown field is HTTP 200 with an `errors` array naming the field, never an HTTP 400.
// - An unknown repository is data.repository = null, with no errors.
// - Unauthenticated is 401 (app.ts, before this handler runs).
// - Global ids are opaque base64 of `Type:<repo-db-id>:<number>` — stable across reads,
//   never the plain numeric id, and decodable for node(id:) and mutation inputs.
// - Two operation documents in one JSON array answer two results, in order.
// Determinism: no wall clock, no unseeded randomness; every id is a pure function of
// the store. Node 22 TypeScript, stdlib only.

import { parseCommit } from './git.ts';
import * as rest from './rest.ts';
import {
  STRANGER_ID,
  VIEWER_ID,
  VIEWER_LOGIN,
  nowIso,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, decodable.
// ---------------------------------------------------------------------------------------------

function encodeGlobalId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

function decodeGlobalId(id: unknown): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const kind = parts.shift();
  if (kind === undefined || kind === '' || parts.length === 0) return null;
  return { kind, parts };
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('Repository', [repo.id]);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', [repo.id, issue.number]);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId('PullRequest', [repo.id, pull.number]);
}

function commentGlobalId(repo: Repo, issueNumber: number, comment: Comment): string {
  return encodeGlobalId('IssueComment', [repo.id, issueNumber, comment.id]);
}

/** A cursor over a sorted list: base64 of `cursor:<index>`, deterministic per list order. */
function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return -1;
  }
  const match = /^cursor:(\d+)$/.exec(text);
  return match === null ? -1 : Number(match[1]);
}

// ---------------------------------------------------------------------------------------------
// The document parser: tokenizer + recursive descent, for the 18 suite documents.
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'eof' };

class ParseError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        const c = source[i] as string;
        if (c === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u' && i + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else if (simple[esc] !== undefined) {
            value += simple[esc] as string;
            i += 2;
          } else {
            value += esc;
            i += 2;
          }
        } else {
          value += c;
          i += 1;
        }
      }
      if (i >= source.length) throw new ParseError('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  args: { name: string; value: ValueNode }[];
  selectionSet?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new ParseError(`expected ${value}`);
  }

  private expectName(what: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new ParseError(`expected ${what}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    const token = this.peek();
    let operation: OperationNode['operation'] = 'query';
    if (token.kind === 'punct' && token.value === '{') {
      return { operation, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      operation = token.value;
      this.next();
    } else {
      throw new ParseError('expected an operation');
    }
    let name: string | undefined;
    const afterOp = this.peek();
    if (afterOp.kind === 'name') {
      name = this.next().value as string;
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.parseVariableDefinitions();
    }
    this.skipDirectives();
    return { operation, name, selectionSet: this.parseSelectionSet() };
  }

  /** Variable definitions carry only names the executor needs; types are skipped. */
  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
      if (this.peek().kind === 'eof') throw new ParseError('unterminated variable definitions');
      this.expectPunct('$');
      this.expectName('a variable name');
      this.expectPunct(':');
      this.skipType();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '=') {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  private skipType(): void {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      this.skipType();
      this.expectPunct(']');
    } else if (token.kind !== 'name') {
      throw new ParseError('expected a type');
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName('a directive name');
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.parseArguments();
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      if (this.peek().kind === 'eof') throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | undefined;
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName('a type condition');
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let name = first;
    let alias: string | undefined;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    let args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      args = this.parseArguments();
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selectionSet };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
      if (this.peek().kind === 'eof') throw new ParseError('unterminated arguments');
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        if (this.peek().kind === 'eof') throw new ParseError('unterminated list');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        if (this.peek().kind === 'eof') throw new ParseError('unterminated input object');
        const name = this.expectName('an input field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new ParseError('expected a value');
  }
}

/** Resolve a parsed value against the operation's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The executor: resolved values carry __typename so inline fragments and field lookup work.
// ---------------------------------------------------------------------------------------------

/** An internal resolved object. Its fields are resolved lazily by resolveField. */
type GqlObject = Record<string, unknown> & { __typename: string };

interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface ExecContext {
  store: Store;
  errors: GqlError[];
}

class FieldError extends Error {}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function userObject(login: string): GqlObject {
  return {
    __typename: 'User',
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : STRANGER_ID,
    name: login === VIEWER_LOGIN ? 'ada iversen' : login,
  };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function commentObject(repo: Repo, issueNumber: number, comment: Comment): GqlObject {
  return { __typename: 'IssueComment', repo, issueNumber, comment };
}

/** The three-way conflict check rest.mergePull uses, for PullRequest.mergeable. */
function mergeableState(repo: Repo, pull: Pull): string {
  const baseTip = repo.git.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.git.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const baseCommit = repo.git.getObject(baseTip);
  const headCommit = repo.git.getObject(headTip);
  if (baseCommit === undefined || headCommit === undefined) return 'UNKNOWN';
  const mergeBase = repo.git.mergeBase(headTip, baseTip);
  if (mergeBase === undefined) return 'MERGEABLE';
  const baseObject = repo.git.getObject(mergeBase);
  if (baseObject === undefined) return 'MERGEABLE';
  const ancestorFiles = repo.git.flattenTree(parseCommit(baseObject.body).tree) ?? new Map<string, string>();
  const baseFiles = repo.git.flattenTree(parseCommit(baseCommit.body).tree) ?? new Map<string, string>();
  const headFiles = repo.git.flattenTree(parseCommit(headCommit.body).tree) ?? new Map<string, string>();
  const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestorSha = ancestorFiles.get(path);
    const baseSha = baseFiles.get(path);
    const headSha = headFiles.get(path);
    if (baseSha !== ancestorSha && headSha !== ancestorSha && baseSha !== headSha) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Pull-request state as GraphQL names it: a merged pull reads MERGED, never CLOSED. */
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** The changed files of a pull request, reusing REST's diff via a shim store. */
function pullFilePaths(repo: Repo, pull: Pull): string[] {
  const store = { getRepo: (): Repo | undefined => repo } as unknown as Store;
  const response = rest.pullFiles(store, repo.owner, repo.name, pull.number);
  if (response.status !== 200 || !Array.isArray(response.body)) return [];
  const paths: string[] = [];
  for (const entry of response.body as Record<string, unknown>[]) {
    if (typeof entry.filename === 'string') paths.push(entry.filename);
  }
  return paths;
}

/** Paginate a sorted list by first/after, returning the page and its pageInfo. */
function paginateList<T>(items: readonly T[], first: number | undefined, after: unknown): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  const start = decodeCursor(after) + 1;
  const end = first === undefined ? items.length : Math.min(items.length, start + first);
  const page = items.slice(start, end);
  return {
    page: [...page],
    hasNextPage: end < items.length,
    endCursor: page.length === 0 ? null : encodeCursor(end - 1),
  };
}

/** Sort issues for a connection: CREATED_AT DESC (ties by number DESC) is the default. */
function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const order = asObject(orderBy);
  const direction = order === null ? 'DESC' : (asString(order.direction) ?? 'DESC');
  const sorted = [...issues];
  sorted.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  return sorted;
}

function filterIssues(issues: Issue[], states: unknown): Issue[] {
  if (!Array.isArray(states) || states.length === 0) return issues;
  const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : '')));
  return issues.filter((issue) => wanted.has(issue.state));
}

/** A synthesized REST request context, so mutations reuse the REST handlers verbatim. */
function restCtx(body: unknown): rest.RequestContext {
  return { method: 'POST', segments: [], pathname: '', query: new URLSearchParams(), body, host: '127.0.0.1' };
}

/** Look a global id up as a repository. */
function repoByGlobalId(store: Store, id: unknown): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository' || decoded.parts.length !== 1) return null;
  const dbId = Number(decoded.parts[0]);
  if (!Number.isInteger(dbId)) return null;
  for (const repo of store.repos.values()) {
    if (repo.id === dbId) return repo;
  }
  return null;
}

/** Look a global id up as an issue (repository + number). */
function issueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue' || decoded.parts.length !== 2) return null;
  const dbId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  for (const repo of store.repos.values()) {
    if (repo.id !== dbId) continue;
    const issue = repo.issues.get(number);
    return issue === undefined ? null : { repo, issue };
  }
  return null;
}

/** Look a global id up as a pull request (repository + number). */
function pullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest' || decoded.parts.length !== 2) return null;
  const dbId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  for (const repo of store.repos.values()) {
    if (repo.id !== dbId) continue;
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Introspection: the field lists gh feature-detects.
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'comments'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork'],
};

const SEARCH_TYPE_VALUES = ['COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'];

function typeObject(name: string): GqlObject | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return { __typename: '__Type', name, kind: 'OBJECT', fieldNames: TYPE_FIELDS[name] as string[], enumNames: null };
  }
  if (name === 'SearchType') {
    return { __typename: '__Type', name, kind: 'ENUM', fieldNames: null, enumNames: SEARCH_TYPE_VALUES };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Field resolution.
// ---------------------------------------------------------------------------------------------

/** Resolve one field of a resolved object; throws FieldError for an unknown field or a failed mutation. */
function resolveField(ctx: ExecContext, parent: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
  const type = parent.__typename;
  switch (type) {
    case 'User': {
      if (field.name === 'login') return parent.login;
      if (field.name === 'id') return parent.id;
      if (field.name === 'name') return parent.name;
      break;
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      if (field.name === 'id') return repoGlobalId(repo);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return repo.fullName;
      if (field.name === 'owner') return userObject(repo.owner);
      if (field.name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch };
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'url') return `https://github.com/${repo.fullName}`;
      if (field.name === 'createdAt') return repo.createdAt;
      if (field.name === 'updatedAt') return repo.updatedAt;
      if (field.name === 'isPrivate') return repo.isPrivate;
      if (field.name === 'fork') return false;
      if (field.name === 'issue') {
        const number = asInt(args.number);
        if (number === undefined) return null;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : issueObject(repo, issue);
      }
      if (field.name === 'issues') {
        const sorted = sortIssues(filterIssues([...repo.issues.values()], args.states), args.orderBy);
        const { page, hasNextPage, endCursor } = paginateList(sorted, asInt(args.first), args.after);
        return {
          __typename: 'IssueConnection',
          nodes: page.map((issue) => issueObject(repo, issue)),
          pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
        };
      }
      if (field.name === 'pullRequests') {
        const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        const { page, hasNextPage, endCursor } = paginateList(pulls, asInt(args.first), args.after);
        return {
          __typename: 'PullRequestConnection',
          nodes: page.map((pull) => pullObject(repo, pull)),
          pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
        };
      }
      if (field.name === 'pullRequest') {
        const number = asInt(args.number);
        if (number === undefined) return null;
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullObject(repo, pull);
      }
      break;
    }
    case 'Issue': {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      if (field.name === 'id') return issueGlobalId(repo, issue);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      if (field.name === 'url') return `https://github.com/${repo.fullName}/issues/${issue.number}`;
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      if (field.name === 'author') return userObject(issue.user.login);
      if (field.name === 'comments') {
        return {
          __typename: 'IssueCommentConnection',
          nodes: issue.comments.map((comment) => commentObject(repo, issue.number, comment)),
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
        };
      }
      if (field.name === 'labels') return issue.labels.map((label) => ({ __typename: 'Label', name: label.name }));
      if (field.name === 'repository') return repoObject(repo);
      break;
    }
    case 'PullRequest': {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      if (field.name === 'id') return pullGlobalId(repo, pull);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pullState(pull);
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'mergeable') return mergeableState(repo, pull);
      if (field.name === 'files') {
        const paths = pullFilePaths(repo, pull);
        const { page, hasNextPage, endCursor } = paginateList(paths, asInt(args.first), args.after);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: page.map((path) => ({ __typename: 'PullRequestChangedFile', path })),
          pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
        };
      }
      if (field.name === 'url') return `https://github.com/${repo.fullName}/pull/${pull.number}`;
      if (field.name === 'createdAt') return pull.createdAt;
      if (field.name === 'updatedAt') return pull.updatedAt;
      if (field.name === 'author') return userObject(pull.user.login);
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection': {
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'edges') {
        const nodes = parent.nodes as GqlObject[];
        return nodes.map((node, index) => ({ __typename: 'Edge', node, cursor: encodeCursor(index) }));
      }
      if (field.name === 'pageInfo') return parent.pageInfo;
      if (field.name === 'totalCount') return (parent.nodes as unknown[]).length;
      break;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.hasNextPage;
      if (field.name === 'endCursor') return parent.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      break;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return parent.node;
      if (field.name === 'cursor') return parent.cursor ?? null;
      break;
    }
    case 'Edge': {
      if (field.name === 'node') return parent.node;
      if (field.name === 'cursor') return parent.cursor;
      break;
    }
    case 'IssueComment': {
      const repo = parent.repo as Repo;
      const comment = parent.comment as Comment;
      if (field.name === 'id') return commentGlobalId(repo, parent.issueNumber as number, comment);
      if (field.name === 'body') return comment.body;
      if (field.name === 'author') return userObject(comment.user.login);
      if (field.name === 'createdAt') return comment.createdAt;
      if (field.name === 'updatedAt') return comment.updatedAt;
      break;
    }
    case 'Label': {
      if (field.name === 'name') return parent.name;
      break;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return parent.path;
      break;
    }
    case '__Type': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'kind') return parent.kind;
      if (field.name === 'fields') {
        const names = parent.fieldNames as string[] | null;
        if (names === null) return null;
        return names.map((name) => ({ __typename: '__Field', name }));
      }
      if (field.name === 'enumValues') {
        const names = parent.enumNames as string[] | null;
        if (names === null) return null;
        return names.map((name) => ({ __typename: '__EnumValue', name }));
      }
      break;
    }
    case '__Field': {
      if (field.name === 'name') return parent.name;
      break;
    }
    case '__EnumValue': {
      if (field.name === 'name') return parent.name;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return parent.issue;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return parent.pullRequest;
      break;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return parent.commentEdge;
      break;
    }
  }
  throw new FieldError(`Cannot query field "${field.name}" on type "${type}".`);
}

/** Resolve the root fields of one operation (viewer, repository, node, __type, mutations). */
function resolveRootField(ctx: ExecContext, operation: OperationNode['operation'], field: FieldNode, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  if (operation === 'query') {
    if (field.name === 'viewer') return userObject(VIEWER_LOGIN);
    if (field.name === 'repository') {
      const owner = asString(args.owner);
      const name = asString(args.name);
      if (owner === undefined || name === undefined) return null;
      const repo = store.getRepo(owner, name);
      return repo === undefined ? null : repoObject(repo);
    }
    if (field.name === 'node') {
      const decoded = decodeGlobalId(args.id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoByGlobalId(store, args.id);
        return repo === null ? null : repoObject(repo);
      }
      if (decoded.kind === 'Issue') {
        const found = issueByGlobalId(store, args.id);
        return found === null ? null : issueObject(found.repo, found.issue);
      }
      if (decoded.kind === 'PullRequest') {
        const found = pullByGlobalId(store, args.id);
        return found === null ? null : pullObject(found.repo, found.pull);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = asString(args.name);
      if (name === undefined) return null;
      return typeObject(name);
    }
    if (field.name === '__schema') return { __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT', fieldNames: null, enumNames: null } };
    throw new FieldError(`Cannot query field "${field.name}" on type "Query".`);
  }
  if (operation === 'mutation') {
    if (field.name === 'createIssue') {
      const input = asObject(args.input);
      if (input === null) throw new FieldError('createIssue needs an input object');
      const repo = repoByGlobalId(store, input.repositoryId);
      if (repo === null) throw new FieldError('createIssue: the repository id names no repository');
      const title = asString(input.title);
      if (title === undefined || title === '') throw new FieldError('createIssue: title is required');
      const response = rest.createIssue(store, repo.owner, repo.name, restCtx({ title, body: asString(input.body) ?? '' }));
      if (response.status !== 201 || !isRecord(response.body)) throw new FieldError('createIssue: the issue could not be created');
      const number = response.body.number as number;
      const issue = repo.issues.get(number);
      if (issue === undefined) throw new FieldError('createIssue: the issue could not be read back');
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
    }
    if (field.name === 'closeIssue') {
      const input = asObject(args.input);
      if (input === null) throw new FieldError('closeIssue needs an input object');
      const found = issueByGlobalId(store, input.issueId);
      if (found === null) throw new FieldError('closeIssue: the issue id names no issue');
      found.issue.state = 'closed';
      found.issue.updatedAt = nowIso();
      return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue) };
    }
    if (field.name === 'createPullRequest') {
      const input = asObject(args.input);
      if (input === null) throw new FieldError('createPullRequest needs an input object');
      const repo = repoByGlobalId(store, input.repositoryId);
      if (repo === null) throw new FieldError('createPullRequest: the repository id names no repository');
      const head = asString(input.headRefName);
      const base = asString(input.baseRefName);
      const title = asString(input.title);
      if (head === undefined || base === undefined || title === undefined) throw new FieldError('createPullRequest: headRefName, baseRefName and title are required');
      const response = rest.createPull(store, repo.owner, repo.name, restCtx({ head, base, title, body: asString(input.body) ?? '' }));
      if (response.status !== 201 || !isRecord(response.body)) throw new FieldError('createPullRequest: the pull request could not be created');
      const number = response.body.number as number;
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new FieldError('createPullRequest: the pull request could not be read back');
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
    }
    if (field.name === 'mergePullRequest') {
      const input = asObject(args.input);
      if (input === null) throw new FieldError('mergePullRequest needs an input object');
      const found = pullByGlobalId(store, input.pullRequestId);
      if (found === null) throw new FieldError('mergePullRequest: the pull request id names no pull request');
      const method = asString(input.mergeMethod);
      const mergeMethod = method === 'MERGE' ? 'merge' : 'squash';
      const response = rest.mergePull(store, found.repo.owner, found.repo.name, found.pull.number, restCtx({ merge_method: mergeMethod }));
      if (response.status !== 200) throw new FieldError(`mergePullRequest: the merge was refused (${response.status})`);
      const pull = found.repo.pulls.get(found.pull.number);
      if (pull === undefined) throw new FieldError('mergePullRequest: the pull request could not be read back');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, pull) };
    }
    if (field.name === 'addComment') {
      const input = asObject(args.input);
      if (input === null) throw new FieldError('addComment needs an input object');
      const found = issueByGlobalId(store, input.subjectId);
      if (found === null) throw new FieldError('addComment: the subject id names no issue');
      const body = asString(input.body);
      if (body === undefined) throw new FieldError('addComment: body is required');
      const response = rest.createComment(store, found.repo.owner, found.repo.name, found.issue.number, restCtx({ body }));
      if (response.status !== 201 || !isRecord(response.body)) throw new FieldError('addComment: the comment could not be created');
      const comment = found.issue.comments[found.issue.comments.length - 1] as Comment;
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: commentObject(found.repo, found.issue.number, comment), cursor: null },
      };
    }
    throw new FieldError(`Cannot query field "${field.name}" on type "Mutation".`);
  }
  throw new FieldError(`unsupported operation ${operation}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve a selection set against a resolved object, building the response object. */
function resolveSelectionSet(ctx: ExecContext, parent: GqlObject, selections: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, resolveSelectionSet(ctx, parent, selection.selectionSet, variables));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, variables);
    let value: unknown;
    try {
      value = resolveField(ctx, parent, selection, args);
    } catch (err) {
      if (err instanceof FieldError) {
        ctx.errors.push({ message: err.message, path: [responseKey] });
        out[responseKey] = null;
        continue;
      }
      throw err;
    }
    out[responseKey] = resolveValueNode(ctx, value, selection.selectionSet, variables, [responseKey]);
  }
  return out;
}

/** Apply a field's sub-selections to its resolved value (scalars pass through). */
function resolveValueNode(
  ctx: ExecContext,
  value: unknown,
  selectionSet: SelectionNode[] | undefined,
  variables: Record<string, unknown>,
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return null;
  if (selectionSet === undefined || selectionSet.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      isRecord(entry) && typeof entry.__typename === 'string'
        ? resolveSelectionSet(ctx, entry as GqlObject, selectionSet, variables)
        : entry,
    );
  }
  if (isRecord(value) && typeof value.__typename === 'string') {
    return resolveSelectionSet(ctx, value as GqlObject, selectionSet, variables);
  }
  return value;
}

/** Execute one parsed operation against the store. */
function executeOperation(
  ctx: ExecContext,
  operation: OperationNode,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of operation.selectionSet) {
    if (selection.kind === 'fragment') {
      // A root fragment has no type to test against; apply it directly.
      Object.assign(out, executeFragment(ctx, operation.operation, selection, variables));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, variables);
    let value: unknown;
    try {
      value = resolveRootField(ctx, operation.operation, selection, args);
    } catch (err) {
      if (err instanceof FieldError) {
        ctx.errors.push({ message: err.message, path: [responseKey] });
        out[responseKey] = null;
        continue;
      }
      throw err;
    }
    out[responseKey] = resolveValueNode(ctx, value, selection.selectionSet, variables, [responseKey]);
  }
  return out;
}

function executeFragment(
  ctx: ExecContext,
  operation: OperationNode['operation'],
  fragment: FragmentNode,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of fragment.selectionSet) {
    if (selection.kind === 'fragment') {
      Object.assign(out, executeFragment(ctx, operation, selection, variables));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, variables);
    let value: unknown;
    try {
      value = resolveRootField(ctx, operation, selection, args);
    } catch (err) {
      if (err instanceof FieldError) {
        ctx.errors.push({ message: err.message, path: [responseKey] });
        out[responseKey] = null;
        continue;
      }
      throw err;
    }
    out[responseKey] = resolveValueNode(ctx, value, selection.selectionSet, variables, [responseKey]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The HTTP handler: one operation object, or a JSON array of them (batching, in order).
// ---------------------------------------------------------------------------------------------

export interface GraphQLHandlerResult {
  status: number;
  body: unknown;
}

function executeOne(store: Store, body: unknown): Record<string, unknown> {
  const ctx: ExecContext = { store, errors: [] };
  const record = asObject(body);
  if (record === null) {
    return { data: null, errors: [{ message: 'the request body must be a JSON object with query and variables' }] };
  }
  const query = asString(record.query);
  if (query === undefined) {
    return { data: null, errors: [{ message: 'the request body carries no query string' }] };
  }
  const variables = asObject(record.variables) ?? {};
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'the query could not be parsed' }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'the query holds no operation' }] };
  }
  // The suite sends one operation per document; an operationName picks one when given.
  let operation = operations[0] as OperationNode;
  const operationName = asString(record.operationName);
  if (operationName !== undefined) {
    const named = operations.find((op) => op.name === operationName);
    if (named !== undefined) operation = named;
  }
  let data: Record<string, unknown>;
  try {
    data = executeOperation(ctx, operation, variables);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'the query could not be executed' }] };
  }
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/** Handle one POST /api/graphql body (object or array of operation objects). */
export function handleGraphQL(store: Store, body: unknown): GraphQLHandlerResult {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(store, entry)) };
  }
  return { status: 200, body: executeOne(store, body) };
}
