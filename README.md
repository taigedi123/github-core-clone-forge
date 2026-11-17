# github-core-clone-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/taigedi123/github-core-clone-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/taigedi123/github-core-clone-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, one-process GitHub-compatible git forge in TypeScript (Node standard library only, no dependencies, no git binary). It serves git smart HTTP — upload-pack protocol v2 (ls-refs, fetch with shallow/deepen semantics, sideband framing) with a v0 fallback, and receive-pack v0 with report-status — plus the REST v3 API under /api/v3 (repositories, contents, refs, branches, commits, labels, issues, comments, pull requests with squash merges), the GraphQL v4 API at /api/graphql (viewer, repository, node, connections with cursor pagination, introspection, and the create/close/merge/comment mutations), and an MCP endpoint at /mcp (server/discover, tools/list, tools/call). All state lives in its own in-memory object store with real SHA-1 git objects, packs with delta resolution, three-way merges and fast-forward enforcement; timestamps come from a logical clock seeded by the trial so runs replay byte-for-byte.

## Run it

```sh
node --experimental-strip-types main.ts
```

The process expects `MAKEFUN_ENV_URL` (the harness origin it registers its ephemeral port with), `MAKEFUN_SHOP_TOKEN` (the bearer token every surface authenticates) and `MAKEFUN_TRIAL_NOW` (the logical clock's seed) in its environment.

---

<sub>Entered on [make.fun](https://make.fun/?ref=5xww654b&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
