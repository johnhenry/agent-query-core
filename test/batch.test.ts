import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBatcher } from "../src/batch.js";

describe("createBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collects adds within the default window and dispatches once", async () => {
    const dispatch = vi.fn(async (reqs: string[]) => reqs.map((r) => `${r}!`));
    const b = createBatcher(dispatch);
    const p1 = b.add("a");
    const p2 = b.add("b");
    const p3 = b.add("c");
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(["a", "b", "c"]);
    await expect(p1).resolves.toBe("a!");
    await expect(p2).resolves.toBe("b!");
    await expect(p3).resolves.toBe("c!");
  });

  it("resolves each add() with its positionally-corresponding result", async () => {
    const dispatch = vi.fn(async (reqs: number[]) => reqs.map((r) => r * 10));
    const b = createBatcher(dispatch);
    const p1 = b.add(1);
    const p2 = b.add(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(await p1).toBe(10);
    expect(await p2).toBe(20);
  });

  it("flushes eagerly once maxSize is reached, without waiting for windowMs", async () => {
    const dispatch = vi.fn(async (reqs: string[]) => reqs);
    const b = createBatcher(dispatch, { windowMs: 60_000, maxSize: 2 });
    const p1 = b.add("a");
    expect(dispatch).not.toHaveBeenCalled();
    const p2 = b.add("b");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(["a", "b"]);
    await expect(p1).resolves.toBe("a");
    await expect(p2).resolves.toBe("b");
  });

  it("starts a fresh window after a flush; does not merge the next batch with the one just dispatched", async () => {
    const dispatch = vi.fn(async (reqs: string[]) => reqs);
    const b = createBatcher(dispatch, { windowMs: 60_000, maxSize: 1 });
    const p1 = b.add("a"); // flushes eagerly (maxSize: 1)
    const p2 = b.add("b"); // starts a new batch, since dispatch #1's promise is still settling
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, ["a"]);
    expect(dispatch).toHaveBeenNthCalledWith(2, ["b"]);
    await expect(p1).resolves.toBe("a");
    await expect(p2).resolves.toBe("b");
  });

  it("rejects every pending caller in the batch with dispatch's rejection", async () => {
    const err = new Error("boom");
    const dispatch = vi.fn(async () => {
      throw err;
    });
    const b = createBatcher(dispatch);
    const p1 = b.add("a");
    const p2 = b.add("b");
    p1.catch(() => {}); // avoid unhandled-rejection noise while timers run
    p2.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await expect(p1).rejects.toBe(err);
    await expect(p2).rejects.toBe(err);
  });

  it("a dispatch that throws synchronously still rejects pending callers (doesn't hang)", async () => {
    const err = new Error("sync boom");
    const dispatch = vi.fn(() => {
      throw err;
    });
    const b = createBatcher(dispatch as unknown as (reqs: string[]) => Promise<string[]>);
    const p1 = b.add("a");
    p1.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await expect(p1).rejects.toBe(err);
  });

  it("rejects every pending caller when dispatch resolves with a mismatched result count", async () => {
    const dispatch = vi.fn(async (reqs: string[]) => reqs.slice(0, 1)); // drops one
    const b = createBatcher(dispatch);
    const p1 = b.add("a");
    const p2 = b.add("b");
    p1.catch(() => {});
    p2.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await expect(p1).rejects.toThrow("2 request(s)");
    await expect(p2).rejects.toThrow("1 result(s)");
  });

  it("flush() forces an immediate dispatch of a non-empty pending batch", async () => {
    const dispatch = vi.fn(async (reqs: string[]) => reqs);
    const b = createBatcher(dispatch, { windowMs: 60_000 });
    const p1 = b.add("a");
    expect(dispatch).not.toHaveBeenCalled();
    b.flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(p1).resolves.toBe("a");
  });

  it("flush() is a no-op when nothing is pending", () => {
    const dispatch = vi.fn(async (reqs: string[]) => reqs);
    const b = createBatcher(dispatch);
    b.flush();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("pendingSize reflects queued-but-undispatched requests", async () => {
    const dispatch = vi.fn(async (reqs: string[]) => reqs);
    const b = createBatcher(dispatch, { windowMs: 60_000 });
    expect(b.pendingSize).toBe(0);
    b.add("a");
    b.add("b");
    expect(b.pendingSize).toBe(2);
    b.flush();
    expect(b.pendingSize).toBe(0);
  });
});
