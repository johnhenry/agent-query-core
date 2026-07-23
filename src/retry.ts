// withRetry — exponential backoff with an explicit idempotency contract.
//
// Two lessons combined:
// - gRPC service config: retry policy is DATA (maxAttempts, backoff, retryable
//   codes), declared once and applied uniformly — hence `RetryPolicy` is a plain
//   object, not a subclass.
// - Stripe idempotency keys: it is only safe to retry a mutating call when the
//   caller has made retrying safe. Stripe forces this by requiring an
//   Idempotency-Key header before retries do anything; we force it with
//   `opts.idempotent` — the caller must ASSERT idempotency, we never infer it.

export interface RetryPolicy {
  /** Max retries AFTER the initial attempt (total calls = retries + 1). */
  retries: number;
  /** First backoff delay. Default 200ms. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 30_000ms. */
  maxDelayMs?: number;
  /** Exponential growth factor. Default 2. */
  factor?: number;
  /** Full jitter (AWS-style: delay = random() * cappedDelay). Default true. */
  jitter?: boolean;
  /** Predicate: is this error retryable? Returning false rethrows. Default: always true. */
  retryOn?: (err: unknown, attempt: number) => boolean;
  /** Injectable randomness for deterministic tests. Default Math.random. */
  random?: () => number;
}

export interface WithRetryOpts {
  /**
   * The caller's assertion that repeating `fn` cannot double-apply its effect.
   * If NOT exactly `true`, the first failure rethrows immediately — no retries.
   *
   * Why so strict: a retried request that the peer already processed is a
   * duplicate side effect (double-send, double-charge, double-spawn). The
   * canonical way to make a protocol call idempotent is to reuse the SAME
   * message/request id on every attempt so the peer can dedupe — e.g. Stripe's
   * Idempotency-Key, JSON-RPC request ids, A2A message ids. Reads are naturally
   * idempotent. If you can't point at the mechanism that makes the retry safe,
   * don't pass `idempotent: true`.
   */
  idempotent: boolean;
  /** Abort retries (and any in-progress backoff delay) promptly. */
  signal?: AbortSignal;
  /** Observability hook, called before each backoff sleep. `attempt` is the 0-based attempt that just failed. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Run `fn` with exponential-backoff retries. `fn` receives the 0-based attempt
 * number (reuse your request id across attempts — see `WithRetryOpts.idempotent`).
 *
 * Delay for the failure of attempt `n`: `min(maxDelayMs, baseDelayMs * factor^n)`,
 * multiplied by `random()` when `jitter` (full jitter). Backoff timers are
 * unref'd, so a pending retry never holds a Node process open on its own; if
 * `signal` fires mid-delay the promise rejects promptly with the abort reason.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  opts: WithRetryOpts,
): Promise<T> {
  const base = policy.baseDelayMs ?? 200;
  const max = policy.maxDelayMs ?? 30_000;
  const factor = policy.factor ?? 2;
  const jitter = policy.jitter ?? true;
  const retryOn = policy.retryOn ?? (() => true);
  const random = policy.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    try {
      return await fn(attempt);
    } catch (err) {
      // Non-idempotent calls NEVER retry — the caller has not asserted that a
      // duplicate execution is safe (see WithRetryOpts.idempotent).
      if (opts.idempotent !== true) throw err;
      if (attempt >= policy.retries) throw err;
      if (!retryOn(err, attempt)) throw err;
      const capped = Math.min(max, base * factor ** attempt);
      const delayMs = jitter ? random() * capped : capped;
      opts.onRetry?.(err, attempt, delayMs);
      await sleep(delayMs, opts.signal);
    }
  }
}

/** Abortable, unref'd sleep (same don't-hold-the-process guard as the cache gc timer). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // Don't hold the (Node) process open for a backoff delay; no-op in browsers.
    (timer as unknown as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
