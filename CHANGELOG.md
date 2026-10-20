# Changelog

## Unreleased

## 0.2.1

- `./browser` export now declares `types` (`dist/index.d.ts`), so TypeScript consumers resolve declarations for the bundle (johnhenry/agent-query-core#19, follow-up to #18).

## 0.2.0

- **Versioned devtools schema** (johnhenry/agent-query-core#17):
  `DEVTOOLS_SCHEMA_VERSION` (1), `DevtoolsHub#snapshot()`, `toSerializableEvent`,
  `parseDevtoolsSnapshot`, and bodyless `summarizeTraffic` / `WireSummary`.
  Documented in `docs/api.md`.
- **Single-file browser ESM bundle**: `@johnhenry/agent-query-core/browser`
  (`dist/browser/index.js`, ~4.9 kB gzip), built by `scripts/bundle.mjs` with esbuild.

- **Node 26 is the floor** (`engines.node` `>=26.0.0`, CI and release on 26,
  `.nvmrc` 26), moved in lockstep across the `*-query` family
  (agent-query-core, a2a-query, acp-query, mcp-query), the family-wide
  standard. Node 26's npm can also publish through npm trusted publishing.

## 0.1.0 — rc.4 promoted to stable (2026-08-25)

**Dropped the `-rc` suffix; `0.1.0-rc.4` becomes `0.1.0` with no code
change.** `0.1.0-rc.4` had been the exact code three sibling packages
(mcp-query, a2a-query, acp-query) depended on since 2026-07-29, so this
makes `latest` resolve to that real code instead of the `0.0.1` baseline,
and lets consumers use a normal `^0.1.0` range instead of an exact
prerelease pin. Promoted in 630dab5.

This package was born scoped as part of the 2026-08 agent-query family
rename (`@johnhenry/mcpq`/`a2aq`/`acpq` → `mcp-query`/`a2a-query`/`acp-query`,
with this core extracted underneath them); it has no prior unscoped npm
identity.
