# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/h05meigames2/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/h05meigames2/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge, written from scratch in TypeScript on the Node standard library only — no git binary, no npm dependencies, no outside service. One process serves git smart HTTP (protocol v2 upload-pack and v0 receive-pack with report-status, side-band-64k and delete-refs), REST v3, GraphQL v4 and MCP, all over a single in-memory store with a hand-implemented git pack protocol (pkt-lines, packfiles, blobs/trees/commits, refs and fast-forward-only pushes). Built for the make.fun competition [github-core-clone-01](https://make.fun/bounty/github-core-clone-01) ("Build a GitHub-compatible git forge").

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=<env origin> node main.ts
```

Requires Node 22.18+ (type stripping is used; nothing is compiled). `main.ts` binds an ephemeral port, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`, then long-polls `$MAKEFUN_ENV_URL/done` and exits 0 when the trial is over.

For a local smoke run without the trial harness, start the app directly against a stub env (see `scripts/` in the kit) or import `createApp` from `app.ts` and listen on a port of your choice; the token check accepts any Bearer token when `MAKEFUN_SHOP_TOKEN` is unset.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | The entry <-> env lifecycle: bind, register, poll `/done`, exit. |
| `app.ts` | The HTTP server: routing, Bearer auth, `X-GitHub-Request-Id` on every reply, JSON bodies everywhere. |
| `gitproto.ts` | The git core: SHA-1 objects, trees/commits/tags, pkt-lines, packfile read/write (incl. OFS/REF deltas), reachability and merge-base. |
| `store.ts` | The in-memory store: repositories, refs, objects, issues, pull requests, labels, a deterministic logical clock (replays are byte-identical). |
| `githttp.ts` | Git smart HTTP: `info/refs` (v0 + v2 advertisements), `ls-refs`, upload-pack v2/v0 with shallow fetches, receive-pack with per-ref ok/ng reports. |
| `rest.ts` | REST v3: repos, branches, commits, contents, labels, issues, comments, pull requests, `Link` pagination. |
| `graphql.ts` | GraphQL v4: a hand-written parser and executor for viewer, repository, node, `__type`, issue/pull-request connections and the five mutations. |
| `mcp.ts` | MCP: `server/discover` (2026-07-28), legacy `initialize`, `tools/list` and `tools/call` for six tools that act on the same store. |
| `http.ts` | The request/response context shared by every surface. |

## Notes

- The viewer is `adaiversen` (the scenario's fixed token owner); repository ids, issue numbers and timestamps are deterministic, so a replayed trial produces identical bytes.
- Pushes are fast-forward-only; a non-fast-forward update is refused per ref with reason `non-fast-forward` and the ref is left unmoved.
- Everything is original code written for this competition.

---

<sub>Entered on [make.fun](https://make.fun/?ref=77v1ce78&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
