// 03 · Optimistic updates — patch immediately, roll back when the mutation fails.
// Run: npx tsx examples/03-optimistic-updates.ts   (no network; the "server" is a stub)
//
// patch() applies recipes and hands back a rollback fn. The UI sees the optimistic
// value instantly; a failed mutation restores exactly what was there before —
// including removing entries that only exist because of the patch.

import { QueryCache } from "../src/index.js";

const cache = new QueryCache<string>({ serializeKey: (k) => k });
const show = (key: string) => cache.getSnapshot(key)?.data ?? "(absent)";

cache.write("todos", [{ id: 1, title: "ship core", done: false }]);

async function toggleDone(fail: boolean) {
  console.log(`\nmutation (server will ${fail ? "FAIL" : "succeed"}):`);
  const rollback = cache.patch([
    {
      key: "todos",
      recipe: (prev) => (prev as { id: number; done: boolean }[]).map((t) => ({ ...t, done: !t.done })),
    },
    { key: "todos:lastMutation", recipe: () => "toggle" }, // a key that never existed — a "ghost"
  ]);
  console.log("  optimistic todos:", show("todos"));
  console.log("  optimistic ghost:", show("todos:lastMutation"));
  try {
    await (fail ? Promise.reject(new Error("500")) : Promise.resolve()); // the fake server call
    console.log("  committed.");
  } catch {
    rollback();
    console.log("  rolled back → todos:", show("todos"));
    console.log("  rolled back → ghost:", show("todos:lastMutation"), "(removed wholesale, not left idle)");
  }
}

await toggleDone(true); // failure path: both patches revert
await toggleDone(false); // success path: optimistic value simply stands
console.log("\nfinal todos:", show("todos"));
