# agent-query-core examples

Runnable, self-verifying examples. Each one uses an injectable clock or a
fake/stub peer — no network, no timers left dangling — and prints the
before/after of the mechanism it demonstrates so the claim in the table
below is checkable by reading the output, not just the source.

| Example | Demonstrates |
| --- | --- |
| [`01-cache-basics.ts`](./01-cache-basics.ts) | `QueryCache.write`/`getSnapshot` round-trip; `isStale` flips from `false` to `true` once `staleTime` elapses while the cached data is untouched (staleness never deletes); `subscribe` fires on a changed write but stays **silent** on a deep-equal rewrite (structural sharing suppresses the no-op notification). |
| [`02-tags-and-invalidation.ts`](./02-tags-and-invalidation.ts) | Tag-based invalidation: a write's declared tags (`entityTag`) determine which entries `invalidateTags` marks stale, including entries that only share a tag transitively (a list carrying the same entity tag as one of its items). `invalidateTags(tags)` fires both `onInvalidate` (local) and `onInvalidateTags` (broadcast); `invalidateTags(tags, false)` — the protocol-driven form — fires only the local callback, never the broadcast one. Invalidating a tag nothing carries is a silent no-op. |
| [`03-optimistic-updates.ts`](./03-optimistic-updates.ts) | `patch()` applies an optimistic recipe immediately and returns a `rollback()`; on a failed mutation, rollback restores the prior value for a real key **and removes wholesale** a "ghost" entry that only existed because of the patch (never leaves it idle) — on a successful mutation, the optimistic value simply stands uncontested. |
| [`04-approval-broker.ts`](./04-approval-broker.ts) | `InteractionBroker.gate()`'s three policy paths side by side: `"allow"` and `"deny"` resolve silently (never touch the queue), `"ask"` queues the interaction until a subscriber calls `resolve()`; an unattended gate with `timeoutMs` is withdrawn from the queue and denied on expiry; every outcome (auto-allow / auto-deny / approved / denied) lands in `auditLog()`. Also shows the decision-cast caveat in practice: a `deny` policy with a decision type that has required fields **must** pass an explicit `autoDeny`. |
| [`05-interceptors.ts`](./05-interceptors.ts) | `runInterceptors`'s Koa-style onion: an `auth` interceptor that mutates `op.context` and calls `next`, wrapping a `timing` interceptor that measures around `next` with `try`/`finally`. An unauthenticated call throws from `auth` **before `timing` ever runs** — a short-circuit, not just an early return. |
| [`06-persistence.ts`](./06-persistence.ts) | `persistCache` debounce-saves a cache to a synchronous storage stand-in and `dehydrate`/`hydrate` round-trip preserves original entry **age** (a snapshot restored 44s later still reports the pre-restore `updatedAt`, so staleness math computed after restore is correct, not reset). Also shows `stop()` actually detaches: writes made after `stop()` are provably absent from the persisted snapshot. |
| [`07-connection-status.ts`](./07-connection-status.ts) | `StatusStore`'s gRPC-style connectivity state machine walked through `connecting → ready → degraded → degraded → ready`: `since` restamps only on a state **change** (two consecutive `degraded` sets in a row do not move `since`), and `attempt` resets to `0` only on reaching `"ready"`. |
| [`08-retry-policy.ts`](./08-retry-policy.ts) | `withRetry`'s idempotency contract: the identical flaky operation rethrows on the **first** failure when `idempotent` is omitted/`false` (no retries, ever), but retries with full-jitter exponential backoff when `idempotent: true` is passed explicitly — with an injected `random` the logged backoff delays are deterministic and match the documented formula. |

## Running

```sh
npm run examples       # run all 8 in sequence (exits non-zero on the first failure)
npm run example:01     # run one
tsx examples/01-cache-basics.ts
```

## Runtime requirements (honest edition)

All eight run under plain Node (via [`tsx`](https://github.com/privatenumber/tsx),
a devDependency) with no network and no browser — every example uses an
injectable clock (`now: () => now`) or an in-memory stand-in (a `Map`-backed
`SyncStorage`, an injected `random`) instead of real timers or I/O, so
output is deterministic and each script exits `0` on success. None of the
examples touch `@johnhenry/agent-query-core/react` — the React bindings
(`useCacheEntry`, `<AgentQueryDevtools>`, …) are exercised by
`test/react.dom.test.tsx` and `test/devtools-panel.dom.test.tsx` instead,
which need `happy-dom`; a devtools-panel example would need a real DOM to
render into and wasn't worth a ninth script for that alone.

These cover the engine's seven core pieces directly
(`QueryCache`, tags/invalidation, optimistic `patch`, `InteractionBroker`,
`runInterceptors`, `persistCache`, `StatusStore`, `withRetry`) —
`instrumentTransport` and `DevtoolsHub` are covered by
[`test/misc.test.ts`](../test/misc.test.ts) instead, since both need a
counterparty (a transport, a panel) that's more naturally a test double
than a standalone runnable demo.
