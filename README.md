# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Valkyra54/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Valkyra54/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in Node 22 TypeScript, stdlib only: one in-memory store
serving REST v3, git smart HTTP, GraphQL v4 and MCP over the same repositories, branches,
commits, issues and pull requests. No dependencies, no git binary, no network beyond the
trial harness — the entry answers the suite on an ephemeral port and exits when the env
says done.

Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

On Node 22.18+ the platform runs `node /bot/main.ts` directly; the flag is harmless there
and makes an older local Node work too. There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib` and its own modules only.

The env origin comes from `MAKEFUN_ENV_URL`. The entry binds an ephemeral port (never
8080), `POST`s `{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls
`GET $MAKEFUN_ENV_URL/done` until `{"done": true}` and exits 0. Without the env var it
exits 1 at once.

## Layout

- `main.ts`: the entry <-> env lifecycle (bind, register, poll done, exit 0), plus a
  graceful-shutdown handler that closes the server on SIGTERM/SIGINT before exiting.
- `app.ts`: the HTTP server — routing, auth, JSON body parsing, and the protocol rules
  (every reply `application/json` with a non-empty `X-GitHub-Request-Id`; errors carry
  `{message}`; a missing or wrong bearer token is 401; a repo under another owner is 404).
- `store.ts`: the forge store — users, repositories, branches, commits, contents, issues,
  comments, labels and pull requests, all deterministic (timestamps from
  `MAKEFUN_TRIAL_NOW`, sequential ids, no wall clock, no unseeded randomness).
- `git.ts`: the git object store — sha1 blob/tree/commit objects, refs, tree building and
  reading, ancestry walks and merge-base, line diffs for pull-request files.
- `rest.ts`: the REST v3 handlers (repos, branches, commits, contents, labels, issues,
  comments, pulls, files, merge) on top of the store.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata, strict TypeScript config,
  licence.

## Surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, no auth |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `GET /api/v3/meta` | 200 `{"installed_version": ...}` |
| `GET /api/v3/user/repos` | the token owner's repositories, `Link: rel="next"` pages |
| `/api/v3/repos/{owner}/{repo}` | repositories, branches, commits, contents, labels, issues, comments, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4 (phases after REST) |
| `POST /mcp` | Model Context Protocol over streamable HTTP (phases after REST) |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` (phases after REST) |
| anything else | 404 `{"message":"Not Found"}` |

Determinism is a first-class rule, not an afterthought: the trial replays every run and
the replay must leave a byte-identical export, so nothing run-varying may reach a response
or stored state — no `Date.now()`, no `Math.random()`, no random ids.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nbgfvtz4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
