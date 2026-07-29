// createBatcher — collect distinct requests issued within a window (or until
// maxSize) and dispatch them together in one call. Adapters decide what a
// batch means on their wire (same tool across servers, same task-poll across
// agents, …); this module knows nothing about Operation or protocols.
//
// Deliberately NOT re-armed per add(), unlike persist.ts's debounce: a batch
// window is armed ONCE, on the first add() into an empty queue. Debouncing
// (reset-on-every-write) would starve a batch forever under a steady stream
// of adds — this must still flush.
//
// Composition with the interceptor onion (runInterceptors): there is no
// exported `batchingInterceptor`. A terminal, non-`next`-calling interceptor
// backed by one shared Batcher IS legal (interceptors may short-circuit
// without calling next), but it silently no-ops anything placed after it in
// the chain — an easy footgun for a caller who later inserts a new
// interceptor "after batching." The clean seam instead: give the adapter's
// own `exec` (the innermost fn passed to runInterceptors) a Batcher, e.g.
//   const batcher = createBatcher(dispatchBatch, { windowMs: 10 });
//   const exec = (op) => batcher.add(toWireReq(op));
//   runInterceptors(interceptors, op, exec);
// Every interceptor still runs per-op, in full, before batching ever begins.

export interface BatcherOptions {
  /** Time window collecting add()s before an automatic flush (ms). Default 0. */
  windowMs?: number;
  /** Eager flush once this many requests are pending. Default: unbounded (windowMs-only). */
  maxSize?: number;
}

export interface Batcher<Req, Res> {
  /** Enqueue one request; resolves/rejects with the item at the same index in the next dispatch. */
  add(req: Req): Promise<Res>;
  /** Force an immediate dispatch of whatever is queued. No-op if nothing is pending. */
  flush(): void;
  /** Requests queued for the next dispatch, not yet sent. */
  readonly pendingSize: number;
}

interface PendingEntry<Req, Res> {
  req: Req;
  resolve: (res: Res) => void;
  reject: (err: unknown) => void;
}

export function createBatcher<Req, Res>(
  dispatch: (reqs: Req[]) => Promise<Res[]>,
  opts: BatcherOptions = {},
): Batcher<Req, Res> {
  const windowMs = opts.windowMs ?? 0;
  let pending: PendingEntry<Req, Res>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flushNow(): void {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    let result: Promise<Res[]>;
    try {
      result = dispatch(batch.map((e) => e.req));
    } catch (err) {
      for (const e of batch) e.reject(err);
      return;
    }
    result.then(
      (results) => {
        if (results.length !== batch.length) {
          const err = new Error(
            `createBatcher: dispatch returned ${results.length} result(s) for a batch of ${batch.length} request(s)`,
          );
          for (const e of batch) e.reject(err);
          return;
        }
        batch.forEach((e, i) => e.resolve(results[i] as Res));
      },
      (err: unknown) => {
        for (const e of batch) e.reject(err);
      },
    );
  }

  return {
    add(req: Req): Promise<Res> {
      return new Promise<Res>((resolve, reject) => {
        pending.push({ req, resolve, reject });
        if (opts.maxSize != null && pending.length >= opts.maxSize) {
          flushNow();
          return;
        }
        if (!timer) {
          timer = setTimeout(flushNow, windowMs);
          // Don't hold the (Node) process open for a pending batch; no-op in browsers.
          (timer as unknown as { unref?: () => void }).unref?.();
        }
      });
    },
    flush: flushNow,
    get pendingSize() {
      return pending.length;
    },
  };
}
