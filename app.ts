// The entry's HTTP surface: routing, auth, JSON body parsing and the protocol rules.
// The REST handlers live in rest.ts; the git object store in git.ts; the forge store in
// store.ts. This file is the only one that touches the wire.
//
// Protocol rules (from the sealed checks):
// - Every reply is application/json (never HTML) with a non-empty X-GitHub-Request-Id.
// - Errors carry a JSON {message}.
// - A missing or wrong bearer token is 401 on every /api/v3 route (except none — /healthz
//   is the only unauthenticated route). A repo under another owner is 404, never 403
//   (rest.ts).
// - A malformed JSON body is 400. An unknown route is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as graphql from './graphql.ts';
import * as mcp from './mcp.ts';
import * as rest from './rest.ts';
import * as githttp from './githttp.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** The bearer token the suite presents, from the trial env (empty locally). */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Sequential request ids: deterministic per request order, never random. */
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Whether this request carries an acceptable bearer token. */
function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return false;
  const token = match[1] as string;
  if (token === '') return false;
  // In a trial the token must match the env's exactly; locally (no env token) any
  // non-empty bearer token is accepted, which is how sdk/run.ts drives the server.
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const all: Record<string, string> = { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId(), ...headers };
  if (status === 204 || body === undefined) {
    res.writeHead(status, all);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  all['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, all);
  res.end(text);
}

function sendResponse(res: ServerResponse, response: rest.Response): void {
  sendJson(res, response.status, response.body, response.headers ?? {});
}

/** Send a git smart-HTTP reply: raw bytes with the service content type. */
function sendGit(res: ServerResponse, response: githttp.GitResponse): void {
  const headers: Record<string, string> = {
    'content-type': response.contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': String(response.body.length),
  };
  res.writeHead(response.status, headers);
  res.end(response.body);
}

/** Read one request body as raw bytes (at most MAX_BODY_BYTES); empty when there is none. */
function readBodyBuffer(req: IncomingMessage): Promise<{ raw: Buffer; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ raw: Buffer.concat(chunks), tooLarge }));
    req.on('error', () => resolve({ raw: Buffer.alloc(0), tooLarge }));
  });
}

/** Read one request body (at most MAX_BODY_BYTES); empty when there is none. */
function readBody(req: IncomingMessage): Promise<{ raw: string; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ raw: Buffer.concat(chunks).toString('utf8'), tooLarge }));
    req.on('error', () => resolve({ raw: '', tooLarge }));
  });
}

interface ParsedRequest {
  pathname: string;
  segments: string[];
  query: URLSearchParams;
}

function parseRequest(req: IncomingMessage): ParsedRequest {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return { pathname: '/', segments: [], query: new URLSearchParams() };
  }
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  return { pathname: url.pathname, segments, query: url.searchParams };
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const parsed = parseRequest(req);
        const method = req.method ?? 'GET';
        const segments = parsed.segments;

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack,
        // /git-receive-pack. Same bearer auth + JSON error rules as REST (401 without
        // a token, 404 for an unknown repo).
        if (segments.length >= 3 && segments[1] !== undefined && segments[1].endsWith('.git')) {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -4);
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const tail = segments.slice(2);
          if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
            const service = parsed.query.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const wantV2 = req.headers['git-protocol'] === 'version=2';
            sendGit(res, githttp.infoRefs(repo, service, wantV2));
            return;
          }
          if (method === 'POST' && tail.length === 1 && (tail[0] === 'git-upload-pack' || tail[0] === 'git-receive-pack')) {
            const { raw, tooLarge } = await readBodyBuffer(req);
            if (tooLarge) {
              sendJson(res, 400, { message: 'request body too large' });
              return;
            }
            if (tail[0] === 'git-upload-pack') {
              const isV2 = req.headers['git-protocol'] === 'version=2';
              sendGit(res, githttp.uploadPack(repo, raw, isV2));
            } else {
              sendGit(res, githttp.receivePack(repo, raw));
            }
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4: POST /api/graphql. Same bearer auth as REST (401 without
        // a token); a JSON object answers one envelope, a JSON array answers
        // one envelope per operation, in order.
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const { raw, tooLarge } = await readBody(req);
          if (tooLarge) {
            sendJson(res, 400, { message: 'request body too large' });
            return;
          }
          let parsed: unknown = null;
          if (raw !== '') {
            try {
              parsed = JSON.parse(raw) as unknown;
            } catch {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
          }
          const result = graphql.handleGraphQL(store, parsed);
          sendJson(res, result.status, result.body);
          return;
        }

        // MCP: POST /mcp, JSON-RPC 2.0 streamable HTTP. Same bearer auth as REST
        // (401 without a token); the raw body goes to mcp.ts, which answers the
        // parse error itself (HTTP 400, JSON-RPC -32700).
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const { raw, tooLarge } = await readBody(req);
          if (tooLarge) {
            sendJson(res, 400, { message: 'request body too large' });
            return;
          }
          const result = mcp.handleMcp(store, raw);
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        // /healthz and the git routes above are the only routes outside /api/v3.
        if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Every /api/v3 route needs a bearer token.
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }

        // Read and parse a JSON body for the methods that carry one.
        let body: unknown;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const { raw, tooLarge } = await readBody(req);
          if (tooLarge) {
            sendJson(res, 400, { message: 'request body too large' });
            return;
          }
          if (raw !== '') {
            try {
              body = JSON.parse(raw) as unknown;
            } catch {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
          }
        }

        const ctx: rest.RequestContext = {
          method,
          segments: segments.slice(2),
          pathname: parsed.pathname,
          query: parsed.query,
          body,
          host: req.headers.host ?? '127.0.0.1',
        };
        const response = dispatch(store, ctx);
        sendResponse(res, response);
      } catch (err) {
        process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}

/** Route one /api/v3 request to its handler. `s` is the segments after /api/v3. */
function dispatch(store: Store, ctx: rest.RequestContext): rest.Response {
  const s = ctx.segments;
  const method = ctx.method;
  const notFound = { status: 404, body: { message: 'Not Found' } } as rest.Response;

  // GET /api/v3/ — the API root, 200 with the token's scopes.
  if (s.length === 0) {
    if (method !== 'GET') return notFound;
    return { status: 200, body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, headers: { 'x-oauth-scopes': 'repo, read:org' } };
  }

  if (s[0] === 'meta' && s.length === 1) {
    if (method !== 'GET') return notFound;
    return { status: 200, body: { installed_version: '1.0.0' } };
  }

  if (s[0] === 'user') {
    if (s.length === 1) {
      if (method !== 'GET') return notFound;
      return { status: 200, body: { login: 'adaiversen', id: 1000, name: 'ada iversen', type: 'User' } };
    }
    if (s.length === 2 && s[1] === 'repos') {
      if (method === 'GET') return rest.listUserRepos(store, ctx);
      if (method === 'POST') return rest.createUserRepo(store, ctx);
    }
    return notFound;
  }

  if (s[0] === 'repos' && s.length >= 3) {
    const owner = s[1] as string;
    const name = s[2] as string;
    const tail = s.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') return rest.getRepo(store, owner, name);
      if (method === 'PATCH') return rest.patchRepo(store, owner, name, ctx);
      if (method === 'DELETE') return rest.deleteRepo(store, owner, name);
      return notFound;
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') return rest.createRef(store, owner, name, ctx);
      if (tail.length >= 3 && method === 'GET') return rest.getRef(store, owner, name, tail.slice(2).join('/'));
      return notFound;
    }

    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') return rest.listBranches(store, owner, name);
      if (tail.length >= 2 && method === 'GET') return rest.getBranch(store, owner, name, tail.slice(1).join('/'));
      return notFound;
    }

    if (tail[0] === 'commits' && tail.length === 1) {
      if (method !== 'GET') return notFound;
      return rest.listCommits(store, owner, name, ctx);
    }

    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'PUT') return rest.putContent(store, owner, name, filePath, ctx);
      if (method === 'GET') return rest.getContent(store, owner, name, filePath, ctx);
      if (method === 'DELETE') return rest.deleteContent(store, owner, name, filePath, ctx);
      return notFound;
    }

    if (tail[0] === 'labels' && tail.length === 1) {
      if (method === 'POST') return rest.createLabel(store, owner, name, ctx);
      if (method === 'GET') return rest.listLabels(store, owner, name);
      return notFound;
    }

    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') return rest.createIssue(store, owner, name, ctx);
        if (method === 'GET') return rest.listIssues(store, owner, name, ctx);
        return notFound;
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number < 1) return notFound;
      if (tail.length === 2) {
        if (method === 'GET') return rest.getIssue(store, owner, name, number);
        if (method === 'PATCH') return rest.patchIssue(store, owner, name, number, ctx);
        return notFound;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'POST') return rest.createComment(store, owner, name, number, ctx);
        if (method === 'GET') return rest.listComments(store, owner, name, number);
      }
      return notFound;
    }

    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') return rest.createPull(store, owner, name, ctx);
        if (method === 'GET') return rest.listPulls(store, owner, name, ctx);
        return notFound;
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number < 1) return notFound;
      if (tail.length === 2) {
        if (method !== 'GET') return notFound;
        return rest.getPull(store, owner, name, number);
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (method !== 'GET') return notFound;
        return rest.pullFiles(store, owner, name, number);
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (method !== 'PUT') return notFound;
        return rest.mergePull(store, owner, name, number, ctx);
      }
      return notFound;
    }
  }

  return notFound;
}
