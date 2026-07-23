import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, type RetryPolicy } from "../src/retry.js";

const flaky = (failures: number, result = "ok") => {
  let calls = 0;
  const fn = vi.fn(async (_attempt: number) => {
    if (calls++ < failures) throw new Error(`fail ${calls}`);
    return result;
  });
  return fn;
};

describe("withRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("succeeds after N failures when idempotent, passing the attempt number to fn", async () => {
    const fn = flaky(2);
    const p = withRetry(fn, { retries: 3, baseDelayMs: 10, jitter: false }, { idempotent: true });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls.map(([a]) => a)).toEqual([0, 1, 2]);
  });

  it("rethrows immediately on the first failure when NOT idempotent", async () => {
    const fn = flaky(1);
    await expect(withRetry(fn, { retries: 5 }, { idempotent: false })).rejects.toThrow("fail 1");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows when retryOn returns false", async () => {
    const retryOn = vi.fn((err: unknown) => !(err as Error).message.includes("fatal"));
    const fn = vi.fn(async () => {
      throw new Error("fatal: bad request");
    });
    await expect(withRetry(fn, { retries: 5, retryOn }, { idempotent: true })).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(retryOn).toHaveBeenCalledWith(expect.any(Error), 0);
  });

  it("rethrows the last error once retries are exhausted", async () => {
    const fn = flaky(10);
    const p = withRetry(fn, { retries: 2, baseDelayMs: 1, jitter: false }, { idempotent: true });
    p.catch(() => {}); // avoid unhandled-rejection noise while timers run
    await vi.runAllTimersAsync();
    await expect(p).rejects.toThrow("fail 3");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("computes the backoff sequence: jittered delays use injected random, capped at maxDelayMs", async () => {
    const delays: number[] = [];
    const policy: RetryPolicy = {
      retries: 4,
      baseDelayMs: 100,
      maxDelayMs: 500,
      factor: 2,
      jitter: true,
      random: () => 0.5,
    };
    const fn = flaky(4);
    const p = withRetry(fn, policy, {
      idempotent: true,
      onRetry: (_err, _attempt, delayMs) => delays.push(delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    // capped = min(500, 100*2^n) = 100, 200, 400, 500; × random(0.5)
    expect(delays).toEqual([50, 100, 200, 250]);
  });

  it("uses deterministic delays when jitter is false", async () => {
    const delays: number[] = [];
    const fn = flaky(3);
    const p = withRetry(
      fn,
      { retries: 3, baseDelayMs: 100, factor: 3, jitter: false },
      { idempotent: true, onRetry: (_e, _a, d) => delays.push(d) },
    );
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(delays).toEqual([100, 300, 900]);
  });

  it("onRetry receives the error and the 0-based attempt that failed", async () => {
    const onRetry = vi.fn();
    const fn = flaky(2);
    const p = withRetry(fn, { retries: 3, baseDelayMs: 5, jitter: false }, { idempotent: true, onRetry });
    await vi.runAllTimersAsync();
    await p;
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]).toEqual([expect.any(Error), 0, 5]);
    expect(onRetry.mock.calls[1]).toEqual([expect.any(Error), 1, 10]);
  });

  it("rejects promptly with the abort reason when the signal fires mid-delay", async () => {
    const ac = new AbortController();
    const fn = flaky(5);
    const p = withRetry(fn, { retries: 5, baseDelayMs: 60_000, jitter: false }, { idempotent: true, signal: ac.signal });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(10); // first attempt fails, backoff armed (60s)
    expect(fn).toHaveBeenCalledTimes(1);
    ac.abort(new Error("user cancelled"));
    await expect(p).rejects.toThrow("user cancelled");
    expect(fn).toHaveBeenCalledTimes(1); // no further attempts
  });

  it("throws the abort reason without calling fn when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort(new Error("too late"));
    const fn = vi.fn(async () => "never");
    await expect(withRetry(fn, { retries: 1 }, { idempotent: true, signal: ac.signal })).rejects.toThrow("too late");
    expect(fn).not.toHaveBeenCalled();
  });
});
