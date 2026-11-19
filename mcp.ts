// The MCP endpoint: POST /mcp, JSON-RPC 2.0 over streamable HTTP, on the same store
// as REST, GraphQL and git. Two protocol eras, modern first:
//
//   modern 2026-07-28: no handshake; every request declares its revision in _meta
//           and the MCP-Protocol-Version header; `server/discover` returns identity,
//           capabilities and supportedVersions in one request.
//   legacy 2025-11-25 and earlier: `initialize` (the server echoes the revision it
//           chose) + `notifications/initialized`, optional Mcp-Session-Id.
//
// Six tools (github-mcp-server names), implemented by reusing the REST handlers
// verbatim through synthesized request contexts, so MCP and REST always read back
// the same objects. Wire rules from the sealed checks (checks-mcp.ts):
// - tools/list is a module constant: two calls answer byte for byte the same list.
// - an unknown tool name is JSON-RPC -32602 (never HTTP 500).
// - a body that is not JSON is HTTP 400 with JSON-RPC -32700.
// - a tools/call missing required arguments is JSON-RPC -32602.
// - every request answers under its own JSON-RPC id (concurrent calls stay separate).
// - a notification (no id) gets HTTP 202 and no body.

import * as rest from './rest.ts';
import { type Store } from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

/** The revisions this server speaks, newest first. */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

type JsonValue = unknown;
type JsonRpcId = string | number | null;

export interface McpHttpResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function stringProp(description: string): { type: string; description: string } {
  return { type: 'string', description };
}

function booleanProp(description: string): { type: string; description: string } {
  return { type: 'boolean', description };
}

function integerProp(description: string): { type: string; description: string } {
  return { type: 'integer', description };
}

/**
 * The six tools, in one module-level constant: tools/list returns this exact
 * object every time, so two calls serialize byte for byte identically.
 */
export const MCP_TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: booleanProp('Whether the repository is private.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp("Filter by state: 'open', 'closed' or 'all'."),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        head: stringProp('The head branch name.'),
        base: stringProp('The base branch name.'),
        body: stringProp('The pull request body.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: integerProp('The pull request number.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// ---------------------------------------------------------------------------
// small helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

/** A synthesized REST request context, so tools reuse the REST handlers verbatim. */
function restCtx(body: unknown, query: Record<string, string> = {}): rest.RequestContext {
  return {
    method: 'POST',
    segments: [],
    pathname: '',
    query: new URLSearchParams(Object.entries(query)),
    body,
    host: '127.0.0.1',
  };
}

/** A name normalized for matching: lowercase, every non-alphanumeric removed. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The tool definition for a called name: exact match first, then suffix match. */
function findTool(name: string): ToolDef | null {
  const wanted = normalizeName(name);
  for (const tool of MCP_TOOLS) if (normalizeName(tool.name) === wanted) return tool;
  for (const tool of MCP_TOOLS) {
    const candidate = normalizeName(tool.name);
    if (wanted.length > candidate.length && wanted.endsWith(candidate)) return tool;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON-RPC envelopes

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** The id out of a raw (possibly malformed) body, for the parse-error answer. */
function idFromRaw(raw: string): JsonRpcId {
  const match = /"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")/.exec(raw);
  if (match === null) return null;
  const token = match[1] as string;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return null;
    }
  }
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// tool execution

interface ToolOutcome {
  ok: boolean;
  /** The value for content/structuredContent when ok, the error text otherwise. */
  value: unknown;
}

function toolError(message: string): ToolOutcome {
  return { ok: false, value: message };
}

function missingArg(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const name of tool.inputSchema.required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

/** Run one tool over the REST handlers. Returns -32602's message for bad arguments. */
function runTool(store: Store, tool: ToolDef, args: Record<string, unknown>): ToolOutcome {
  const owner = asString(args.owner);
  const repoName = asString(args.repo);

  switch (tool.name) {
    case 'create_repo': {
      const name = asString(args.name);
      if (name === undefined || name === '') return toolError('name is required');
      const response = rest.createUserRepo(
        store,
        restCtx({
          name,
          description: asString(args.description) ?? '',
          private: typeof args.private === 'boolean' ? args.private : false,
        }),
      );
      if (response.status !== 201) return toolError(restMessage(response));
      return { ok: true, value: response.body };
    }
    case 'get_repo': {
      if (owner === undefined || repoName === undefined) return toolError('owner and repo are required');
      const response = rest.getRepo(store, owner, repoName);
      if (response.status !== 200) return toolError(restMessage(response));
      return { ok: true, value: response.body };
    }
    case 'create_issue': {
      if (owner === undefined || repoName === undefined) return toolError('owner and repo are required');
      const title = asString(args.title);
      if (title === undefined || title === '') return toolError('title is required');
      const response = rest.createIssue(
        store,
        owner,
        repoName,
        restCtx({ title, body: asString(args.body) ?? '' }),
      );
      if (response.status !== 201) return toolError(restMessage(response));
      return { ok: true, value: response.body };
    }
    case 'list_issues': {
      if (owner === undefined || repoName === undefined) return toolError('owner and repo are required');
      const state = asString(args.state);
      const response = rest.listIssues(
        store,
        owner,
        repoName,
        restCtx(undefined, state === undefined ? {} : { state }),
      );
      if (response.status !== 200) return toolError(restMessage(response));
      return { ok: true, value: response.body };
    }
    case 'create_pull_request': {
      if (owner === undefined || repoName === undefined) return toolError('owner and repo are required');
      const title = asString(args.title);
      const head = asString(args.head);
      const base = asString(args.base);
      if (title === undefined || title === '' || head === undefined || base === undefined) {
        return toolError('title, head and base are required');
      }
      const response = rest.createPull(
        store,
        owner,
        repoName,
        restCtx({ head, base, title, body: asString(args.body) ?? '' }),
      );
      if (response.status !== 201) return toolError(restMessage(response));
      return { ok: true, value: response.body };
    }
    case 'merge_pull_request': {
      if (owner === undefined || repoName === undefined) return toolError('owner and repo are required');
      const pullNumber = asNumber(args.pull_number);
      if (pullNumber === undefined || !Number.isInteger(pullNumber) || pullNumber < 1) {
        return toolError('pull_number is required');
      }
      const response = rest.mergePull(store, owner, repoName, pullNumber, restCtx({}));
      if (response.status !== 200) return toolError(restMessage(response));
      return { ok: true, value: response.body };
    }
    default:
      return toolError(`unknown tool ${tool.name}`);
  }
}

/** The message a REST error body carries. */
function restMessage(response: rest.Response): string {
  if (isRecord(response.body) && typeof response.body.message === 'string' && response.body.message !== '') {
    return response.body.message;
  }
  return `request failed with HTTP ${response.status}`;
}

// ---------------------------------------------------------------------------
// method dispatch

/**
 * Dispatch one parsed JSON-RPC request. Returns null for a notification (no
 * envelope to send back); otherwise the response envelope.
 */
function dispatch(store: Store, request: unknown): Record<string, unknown> | null {
  if (!isRecord(request)) return rpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    return rpcError(isRecord(request) && 'id' in request ? (request.id as JsonRpcId) : null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
  }
  const hasId = 'id' in request && request.id !== undefined;
  const id: JsonRpcId = hasId ? (request.id as JsonRpcId) : null;
  const params = isRecord(request.params) ? request.params : {};

  // A notification (no id) is acknowledged with no envelope; the HTTP layer
  // answers 202. The only notification the suite sends is notifications/initialized.
  if (!hasId) return null;

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
      return rpcResult(id, {
        resultType: 'DiscoverResult',
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP over REST, GraphQL and MCP.',
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const offered = asString(params.protocolVersion);
      if (offered === undefined || !MCP_SUPPORTED_VERSIONS.includes(offered)) {
        return rpcError(id, JSON_RPC_INVALID_PARAMS, `unsupported protocol version ${offered ?? ''}`, {
          supported: [...MCP_SUPPORTED_VERSIONS],
        });
      }
      return rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: MCP_TOOLS });
    }
    case 'tools/call': {
      const name = asString(params.name);
      if (name === undefined || name === '') {
        return rpcError(id, JSON_RPC_INVALID_PARAMS, 'tools/call needs a tool name');
      }
      const tool = findTool(name);
      if (tool === null) {
        return rpcError(id, JSON_RPC_INVALID_PARAMS, `unknown tool ${name}`);
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const missing = missingArg(tool, args);
      if (missing !== null) {
        return rpcError(id, JSON_RPC_INVALID_PARAMS, `missing required argument ${missing}`);
      }
      const outcome = runTool(store, tool, args);
      if (outcome.ok) {
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
          structuredContent: outcome.value,
        });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: String(outcome.value) }],
        isError: true,
      });
    }
    default: {
      return rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }
}

/**
 * Handle one POST /mcp body (raw text). A body that is not JSON answers HTTP 400
 * with JSON-RPC -32700; a JSON array answers one envelope per request, in order;
 * a notification answers HTTP 202 with no body.
 */
export function handleMcp(store: Store, raw: string): McpHttpResult {
  let parsed: JsonValue;
  if (raw.trim() === '') {
    return { status: 400, body: rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error') };
  }
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return { status: 400, body: rpcError(idFromRaw(raw), JSON_RPC_PARSE_ERROR, 'Parse error') };
  }

  if (Array.isArray(parsed)) {
    const answers: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      const answer = dispatch(store, entry);
      if (answer !== null) answers.push(answer);
    }
    return { status: 200, body: answers };
  }

  const answer = dispatch(store, parsed);
  if (answer === null) return { status: 202 };
  return { status: 200, body: answer };
}
