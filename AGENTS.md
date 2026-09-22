# Agent playbook

`@johnhenry/agent-query-core` — the protocol-agnostic reactive cache /
human-in-the-loop broker / interceptor / devtools engine shared by the
`*-query` family (mcp-query, a2a-query, acp-query). Single package, Node
>= 22 (see [Repo-specific gotchas](#repo-specific-gotchas) on why this
differs from the rest of the `@johnhenry` family), vitest (`npm test`),
builds to `dist/` via `tsc` (two entrypoints: `.` and `./react`). The
library itself has zero runtime dependencies; React is an optional peer
consumed only by `src/react/*`.

`CLAUDE.md` in this directory is a symlink to this file.

## The verification loop (before every push)

1. `npm run typecheck`
2. `npm test` — vitest; no suite here is configured to skip, so any skip is
   a regression, not a known gap.
3. `npm run test:coverage`
4. `npm run build && npm pack --dry-run` — read the file list (`dist` only,
   per `files`), not just the exit code.
5. A genuinely fresh clone:
   `git clone . /tmp/agent-query-core-verifyN && cd $_ && npm ci && npm run build && npm test`.
   This is the only way to catch "works on my checked-out tree" bugs
   (`peerDependenciesMeta.react.optional` in particular: a fresh install
   without React must still build and test cleanly).
6. Commit, push, close the issue with a comment naming the commit SHA.

CI (`.github/workflows/ci.yml`) runs, in order: `npm ci` → `npm run
typecheck` → `npm test` → `npm run test:coverage` → `npm run build` → a
publish smoke step that imports the built `dist/index.js` and asserts
`QueryCache` is exported. Match that order locally.

## Repo-specific gotchas

- **React is an optional peer dependency — the root entrypoint must never
  import it.** `peerDependenciesMeta.react.optional: true` in
  `package.json`; `src/index.ts` (the `.` export) has zero React imports.
  Only `src/react/index.ts` and `src/react/devtools.tsx` (the separate
  `./react` export) import `react`/`useSyncExternalStore`. Adding a React
  import to any file reachable from the root entrypoint breaks every
  non-React consumer's install (mcp-query's server-side modules, for one).
- **`QueryCache<K>` is generic over the *adapter's* structured key type —
  the adapter supplies the serializer, not the core.** This is a load-bearing
  design constraint, not incidental genericity: `serializeKey` is a
  constructor option (`src/cache.ts`'s `QueryCacheOptions`), and the core
  has no canonical key shape of its own. Don't add protocol-flavored
  fields (a `server` string, a `tool` name) to `CacheEntry` or `CacheKey`
  here — that vocabulary belongs in the adapter (see mcp-query's own
  `CacheKey` union for what "the adapter supplies the serializer" looks
  like downstream).
- **Interceptor ordering is Koa/Connect-style onion, not a flat middleware
  array.** `runInterceptors` dispatches interceptor `i` before `i+1`, and
  `next()` recurses forward through the same list — an interceptor that
  never calls `next` short-circuits everything after it (`src/interceptors.ts`).
  Code that reasons about interceptor order (auth before timing, redaction
  last) must reason about it as nested `try`/`finally`, not sequential
  execution.
- **`engines.node` is `>=22.0.0` here, not the family's `>=26.0.0` floor —
  deliberate, not a gap.** `a2a-query`, `acp-query`, and `mcp-query` (this
  package's only consumers) genuinely run Node 22 in CI; bumping the floor
  here without bumping all four in lockstep would just make this package's
  stated floor a lie. Don't "fix" this to `>=26` without first verifying
  the whole `*-query` family on 26 and coordinating the bump across all
  four repos.

## Definition of done

A change is done when all of the following hold, not just when tests pass:

- A regression test exists for any bug fixed — fixing a bug without a test
  that would have caught it means it can come back unnoticed.
- Anything the feature does **not** do is stated in `docs/design.md` or
  `docs/api.md` (or the code), not only in an issue comment.
- `CHANGELOG.md` has an entry citing the commit (and PR, when one exists).
- If the change touches a public export, `docs/api.md` gets the matching
  example and the root README's "What's inside" bullet stays accurate.
- If the change adds or changes an `examples/` file,
  [`examples/README.md`](./examples/README.md)'s table is updated to match
  — every file in `examples/` must appear there with an accurate
  `Demonstrates` claim.
- New extension points (a new interaction type, a new adapter-shaped
  touchpoint) are checked against [`## Adding a new
  protocol`](./README.md#adding-a-new-protocol) in the README — update that
  section if the real touchpoints it describes changed.

## Non-goals

No wire code, no protocol vocabulary, no opinions about what a "resource"
or a "task" is — that's deliberately the adapter's job, not this package's
(see `docs/design.md`'s opening paragraph). Patches that add
protocol-specific behavior here (MCP/A2A/ACP-flavored branches, hardcoded
tag conventions) belong in an adapter instead.

## Releases

Bump `version` in `package.json` in a PR, add the `CHANGELOG.md` entry,
merge, then push a tag matching it (`git tag v<version> && git push origin
v<version>`) or dispatch `.github/workflows/release.yml` manually — its
trigger is tag-push / `workflow_dispatch`, not the family's usual
release-triggered convention. The workflow is idempotent (an `npm view`
pre-flight skips a version already on the registry) and routes prerelease
versions (`-rc.N`) to the `rc` dist-tag, stable versions to `latest`.
