// 08 · Retry policy — backoff with an explicit idempotency contract.
// Run: npx tsx examples/08-retry-policy.ts   (no network; injected random for determinism)
//
// withRetry NEVER retries unless the caller asserts `idempotent: true` — the
// Stripe idempotency-key lesson: a retried mutation the peer already processed
// is a duplicate side effect. Make the call idempotent (e.g. reuse the same
// message id across attempts so the peer dedupes), THEN assert it.

import { withRetry, type RetryPolicy } from "../src/index.js";

// Backoff timers are deliberately unref'd (a pending retry never holds a Node
// process open on its own) — in a real app the server/CLI event loop keeps the
// process alive. This script has nothing else running, so hold it open manually:
const keepalive = setInterval(() => {}, 1_000);

const makeFlakyOp = (failures: number) => {
  let calls = 0;
  return async (attempt: number) => {
    calls++;
    console.log(`  attempt ${attempt} (call #${calls}) — reusing message id "msg-42"`);
    if (calls <= failures) throw new Error(`503 from peer (call ${calls})`);
    return `delivered after ${calls} calls`;
  };
};

const policy: RetryPolicy = {
  retries: 3,
  baseDelayMs: 100,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: true,
  random: () => 0.5, // injected randomness → deterministic logged delays
  retryOn: (err) => (err as Error).message.startsWith("503"), // only transient failures
};

// ── 1. NOT idempotent: the first failure rethrows immediately ───────────────
console.log("non-idempotent send (no dedupe mechanism → no retries):");
try {
  await withRetry(makeFlakyOp(2), policy, { idempotent: false });
} catch (err) {
  console.log(`  ✗ rethrown immediately: ${(err as Error).message}\n`);
}

// ── 2. Idempotent: retries with full-jitter exponential backoff ─────────────
console.log("idempotent send (same message id every attempt → safe to retry):");
const result = await withRetry(makeFlakyOp(2), policy, {
  idempotent: true,
  onRetry: (err, attempt, delayMs) =>
    console.log(`  ↻ attempt ${attempt} failed (${(err as Error).message}) — backing off ${delayMs}ms`),
});
console.log(`  ✓ ${result}`);
console.log("    (delays = random 0.5 × min(30000, 100·2^attempt) → 50ms, 100ms)");
clearInterval(keepalive);
