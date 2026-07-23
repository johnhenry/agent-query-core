# @johnhenry/agent-query-core

**The protocol-agnostic engine behind the `*-query` family of agent-protocol data layers.**

[mcp-query](https://github.com/johnhenry/mcp-query) proved a shape: a reactive, cached,
embeddable client data layer sitting on a protocol's official low-level SDK — the
TanStack-Query-of-X move. This package is that shape's engine, extracted so sibling
libraries ([a2a-query](https://github.com/johnhenry/a2a-query), acp-query, …) share one
implementation while each adapter supplies its protocol vocabulary (key kinds, tag
conventions, interaction types, transports).

## Docs & examples

- **[docs/design.md](./docs/design.md)** — the engine's concepts: cache semantics
  (staleness vs gc vs tags vs structural sharing), the broker model (policy/queue/audit
  and the `gate()` contract), the interceptor onion, and how adapters bind (with real
  a2aq/acpq usage).
- **[docs/api.md](./docs/api.md)** — every export, one example each.
- **[examples/](./examples)** — graded runnable demos, no network:
  `npx tsx examples/01-cache-basics.ts` (or `npm run example:01` … `example:08`) —
  including [07-connection-status](./examples/07-connection-status.ts) and
  [08-retry-policy](./examples/08-retry-policy.ts).

## What's inside

- **`QueryCache<K>`** — staleTime/gcTime, tag-based invalidation (RTK-Query style),
  ref-counted subscribers driving gc and protocol subscriptions, structural sharing,
  optimistic patch/rollback, dehydrate/hydrate. Generic over the adapter's structured
  key type; the adapter supplies the serializer.
- **`InteractionBroker<D>`** — one queue for every human-in-the-loop decision point
  (permissions, input requests, approvals, consent): trust policy (allow/deny/ask),
  pending queue for UI binding, audit ring with sinks. Interaction types are
  adapter-defined strings; decisions are generic.
- **`runInterceptors`** — a Koa-style onion around logical operations
  (auth, tracing, rate limits, redaction).
- **`instrumentTransport`** — a structural Proxy tap for wire devtools.
- **`DevtoolsHub<TEvent>`** — ring-buffer event hub for panels.
- **`MemoryCacheStore` / `CacheStore`** — the async L2 tier interface
  (cross-instance sharing + distributed invalidation).
- **`persistCache`** — offline/restore via any synchronous storage.
- **`StatusStore`** — per-peer connectivity as a versioned reactive store
  (gRPC channel-state model: idle/connecting/ready/degraded/closed).
- **`withRetry`** — exponential backoff with full jitter and an explicit
  idempotency assertion (no silent retry of non-idempotent calls).
- **Refetch triggers** — `focusTrigger` / `onlineTrigger` / `intervalTrigger` +
  `wireRevalidation` (mark-stale-on-occasion, TanStack style).
- **`@johnhenry/agent-query-core/react`** — `useCacheEntry`, `useInteractions`,
  `useAuditLog`, `useVersioned`, `usePeerStatus` (thin `useSyncExternalStore`
  bindings) and the `<AgentQueryDevtools>` panel.

## Family

| Protocol | Library | Status |
|---|---|---|
| MCP | [`@johnhenry/mcpq`](https://github.com/johnhenry/mcp-query) | shipping (adopts core in a future major) |
| A2A | [`@johnhenry/a2aq`](https://github.com/johnhenry/a2a-query) | in development — first core consumer |
| ACP | `@johnhenry/acpq` | planned |
| AP2 | a2aq extension module | planned (verification/audit slice first) |

MIT
