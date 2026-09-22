# Changelog

## Unreleased

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
