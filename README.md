# @johnhenry/agent-query-core

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fagent-query-core.svg)](https://www.npmjs.com/package/@johnhenry/agent-query-core)
[![CI](https://github.com/johnhenry/agent-query-core/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/agent-query-core/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fagent-query-core.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/agent-query](https://opensource.johnhenry.me/agent-query/)

**The protocol-agnostic engine behind the `*-query` family of agent-protocol data layers.**

[mcp-query](https://github.com/johnhenry/mcp-query) proved a shape: a reactive, cached,
embeddable client data layer sitting on a protocol's official low-level SDK — the
TanStack-Query-of-X move. This package is that shape's engine, extracted so sibling
libraries ([a2a-query](https://github.com/johnhenry/a2a-query), acp-query, …) share one
implementation while each adapter supplies its protocol vocabulary (key kinds, tag
conventions, interaction types, transports).

## Contents

- [Install](#install)
- [Protocol versions](#protocol-versions)
- [Docs & examples](#docs--examples)
- [What's inside](#whats-inside)
- [Adding a new protocol](#adding-a-new-protocol)
- [Family](#family)

## Install

```sh
npm install @johnhenry/agent-query-core
```

This package was born scoped as part of the 2026-08 `@johnhenry` family rename;
it has no prior unscoped npm identity (see [CHANGELOG.md](./CHANGELOG.md)).

## Protocol versions

`agent-query-core` doesn't speak a wire protocol — it's the shared cache/broker/
interceptor engine. For which spec versions each protocol adapter supports, see:
[mcp-query](https://github.com/johnhenry/mcp-query) (MCP),
[a2a-query](https://github.com/johnhenry/a2a-query) (A2A),
[acp-query](https://github.com/johnhenry/acp-query) (ACP).

## Docs & examples

- **[docs/design.md](./docs/design.md)** — the engine's concepts: cache semantics
  (staleness vs gc vs tags vs structural sharing), the broker model (policy/queue/audit
  and the `gate()` contract), the interceptor onion, and how adapters bind (with real
  a2a-query/acp-query usage).
- **[docs/api.md](./docs/api.md)** — every export, one example each.
- **[examples/](./examples)** — 8 graded, runnable, self-verifying demos, no
  network: `npm run examples` (all in sequence) or `npm run example:01` …
  `example:08` (one at a time); see [`examples/README.md`](./examples/README.md)
  for the full table of what each one demonstrates.

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

## Adding a new protocol

The three shipped adapters ([mcp-query](https://github.com/johnhenry/mcp-query),
[a2a-query](https://github.com/johnhenry/a2a-query),
[acp-query](https://github.com/johnhenry/acp-query)) are the real worked
examples, not a hypothetical — [docs/design.md](./docs/design.md)'s
"[Convergent evolution: three protocols, one
broker](./docs/design.md#convergent-evolution-three-protocols-one-broker)"
and "[How adapters bind — real
usage](./docs/design.md#how-adapters-bind--real-usage)" sections are the
citable record of how MCP, A2A, and ACP each routed their own pause-and-ask
moment through the exact same `gate()` call with zero broker redesign.
mcp-query's own migration onto this core (`packages/mcp-query/src/core/cache.ts`,
tracked as its issue #18) is the harder case worth reading too: rebasing an
*existing*, previously from-scratch adapter cache onto `QueryCache<K>`,
which is closer to what most future changes here will look like than
building a brand-new adapter from zero.

**Smallest: a new interaction TYPE string on an existing adapter.** Interaction
types are just adapter-defined strings passed to
[`InteractionBroker<D>.gate(type, peer, payload, opts)`](./src/broker.ts) —
acp-query's entire vocabulary is one string, `"permission"` (acp-query's
`src/client.ts`); mcp-query uses two, `"sampling"`/`"elicitation"`. A protocol revision that adds one more
pause-and-ask moment to an adapter that already exists is just another
string literal and, if its payload needs new fields, another
`interface extends BaseDecision` — no core change, no new package. The test
that decides whether that's enough: does the new moment need a structured
key shape, transport primitive, or wire vocabulary the existing adapter
genuinely doesn't have — not just a new decision variant on a mechanism
that's already wired up?

**A genuinely new protocol adapter** (the next real candidate is AP2, listed
`planned` in [Family](#family) below) touches four things, following the
pattern every shipped adapter already does:

1. **A structured key type + serializer for `QueryCache<K>`**
   (`src/cache.ts`'s `QueryCacheOptions.serializeKey`). Each adapter owns
   its own key union: mcp-query's `CacheKey`
   (`packages/mcp-query/src/core/keys.ts`) — `resource` / `toolList` /
   `toolResult` / `task` / … kinds, tool results keyed by
   `{server, tool, argsHash}`; a2a-query's two-kind `A2AKey`
   (`{kind:"card"}` / `{kind:"task"}`, per its own design.md); acp-query's
   single `{kind:"session"; id}` key. A new adapter copies the shape of
   whichever sibling is topologically closest — request/response toward
   mcp-query's, a long-lived session toward acp-query's.
2. **Interaction-type strings + a `BaseDecision` extension for
   `InteractionBroker<D>`** (`src/broker.ts`) — enumerate the protocol's own
   pause points as strings and, where the decision carries protocol data,
   an interface like a2a-query's `InputDecision` (`message?: Message`) or
   acp-query's `PermissionDecision` (`optionId?: string`).
3. **Wiring `instrumentTransport` (`src/instrument.ts`) for a wire-devtools
   tap** — the three siblings don't even share one shape here, which is the
   point: mcp-query's `packages/mcp-query/src/core/instrument.ts` wraps the
   SDK's own stdio/HTTP `Transport` directly through core's
   `instrumentTransport` (a structural cast, since the SDK's generically-typed
   `Transport` and core's `TransportLike` don't unify in TS despite matching
   at runtime); a2a-query's `src/wire.ts` `tapFetch` is the fetch-shaped
   analog of the same idea, because its wire surface is an injected `fetch`,
   not a `{send, onmessage}` object; acp-query's `src/instrument.ts`
   `instrumentAcpStream` taps the SDK's duplex stream. Pick whichever matches
   the new protocol's own transport primitive.
4. **The one part that isn't boilerplate: the protocol-adapter logic
   itself.** Every shipped adapter's actual engine is a different mechanism
   riding the same cache/broker substrate — mcp-query's **tool-call cache**
   (the `toolResult` key kind above, written on every `callTool()`);
   a2a-query's **task-handle store** (`sendMessage()` returns a poll-driven
   `TaskHandle` whose snapshots land in the reactive cache via `task()` /
   `subscribe()` / `result()`); acp-query's **session/turn fold**
   (`session/update` notifications fold into a `SessionState` under one
   `{kind:"session"; id}` key — not a query cache at all, a reactive
   stream-fold, by acp-query's own design.md). This is the file that makes
   the new package worth writing; touchpoints 1–3 are wiring the substrate
   so this one doesn't have to reinvent it.

**Tests against a local mock, never a live server** — the pattern all three
siblings share because each protocol's own SDK ships (or trivially permits)
a real in-process implementation: mcp-query's `MockMCPServer` (the real SDK
server class over an in-memory transport), a2a-query's
`@johnhenry/a2a-query/testing` (the SDK's own `DefaultRequestHandler` +
`InMemoryTaskStore` behind an injected `fetch`), acp-query's
`@johnhenry/acp-query/testing` (the SDK's own `agent()` builder wired
straight to the client). A new adapter should hold out for the same:
real protocol logic, no sockets, no hand-rolled stub standing in for the
spec.

## Family

| Protocol | Library | Status |
|---|---|---|
| MCP | [`@johnhenry/mcp-query`](https://github.com/johnhenry/mcp-query) | published — core consumer |
| A2A | [`@johnhenry/a2a-query`](https://github.com/johnhenry/a2a-query) | published — core consumer |
| ACP | `@johnhenry/acp-query` | published — core consumer |
| AP2 | a2a-query extension module | planned (verification/audit slice first) |

MIT
