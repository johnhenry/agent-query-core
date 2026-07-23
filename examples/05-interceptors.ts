// 05 · Interceptors — an auth interceptor and a timing interceptor wrapped
// around a fake operation, Koa-onion style.
// Run: npx tsx examples/05-interceptors.ts   (no network)
//
// The chain wraps the LOGICAL operation, not the transport. Interceptors can
// mutate the operation, short-circuit (return/throw without next), and observe
// results and timing with try/finally around next.

import { runInterceptors, type Operation, type RequestInterceptor } from "../src/index.js";

// ── auth: reject operations with no principal; stamp context for downstream ──
const auth: RequestInterceptor = async (op, next) => {
  const principal = (op.args?.token as string | undefined) === "s3cret" ? "ada" : undefined;
  if (!principal) throw new Error(`unauthenticated ${op.kind} of ${op.target}`);
  op.context = { ...(op.context ?? {}), meta: { ...(op.context?.meta ?? {}), principal } };
  return next(op);
};

// ── timing: measure everything inside it (auth already ran → only authed ops) ─
const timing: RequestInterceptor = async (op, next) => {
  const t0 = performance.now();
  try {
    return await next(op);
  } finally {
    console.log(`  [timing] ${op.kind} ${op.target} took ${(performance.now() - t0).toFixed(1)}ms`);
  }
};

// ── the innermost "real" operation ──────────────────────────────────────────
const exec = async (op: Operation) => {
  await new Promise((r) => setTimeout(r, 25)); // pretend to do work
  return `echo(${op.args?.text}) as ${(op.context?.meta as { principal: string }).principal}`;
};

const call = (args: Record<string, unknown>): Promise<unknown> =>
  runInterceptors([auth, timing], { kind: "call", peer: "srv", target: "tools/echo", args, state: {} }, exec);

console.log("authorized call:");
console.log("  result:", await call({ text: "hi", token: "s3cret" }));

console.log("unauthorized call (auth short-circuits BEFORE timing ever runs):");
try {
  await call({ text: "hi" });
} catch (err) {
  console.log("  threw:", (err as Error).message);
}
