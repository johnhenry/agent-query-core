// Request interceptor chain — the server-side seam. A Koa/Connect-style onion around
// the LOGICAL operation (read / call / query / whatever the adapter defines), not the
// transport. Interceptors can short-circuit (return or throw without calling next),
// observe result/error/timing, and mutate the operation (context, args) before it
// runs. Authorization, tracing, rate-limiting, redaction all hang here.

export interface OperationContext {
  partition?: string;
  meta?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Operation {
  /** Adapter-defined operation kind ("read" | "call" | "send" | …). */
  kind: string;
  /** The remote party (server / agent / merchant …). */
  peer: string;
  /** Operation target (URI, tool name, task id, …). */
  target: string;
  /** Arguments (mutable). */
  args?: Record<string, unknown>;
  /** The resolved definition (tool/skill/…) — adapters read annotations here. */
  def?: unknown;
  /** Per-call context (partition + meta/principal). Mutable. */
  context?: OperationContext;
  /** Scratch bag for interceptors to thread data down the chain (e.g. a span, start time). */
  readonly state: Record<string, unknown>;
}

/** Invoke the next interceptor (or the real operation at the end of the chain). */
export type Next = (op: Operation) => Promise<unknown>;

/** `(op, next) => next(op)` — wrap, mutate, short-circuit, or observe. */
export type RequestInterceptor = (op: Operation, next: Next) => Promise<unknown>;

/** Run `op` through the chain, with `exec` as the innermost (the actual operation). */
export function runInterceptors(
  interceptors: readonly RequestInterceptor[],
  op: Operation,
  exec: Next,
): Promise<unknown> {
  const dispatch = (i: number, o: Operation): Promise<unknown> => {
    const fn = i === interceptors.length ? exec : interceptors[i]!;
    return fn(o, (nextOp) => dispatch(i + 1, nextOp));
  };
  return dispatch(0, op);
}
