import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Builds the single-file browser bundle and checks it is self-contained.
describe("browser ESM bundle", () => {
  it("is a single file with no imports and exports the core API", async () => {
    execFileSync("node", ["scripts/bundle.mjs"], { stdio: "pipe" });
    expect(existsSync("dist/browser/index.js")).toBe(true);
    const src = readFileSync("dist/browser/index.js", "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/from\s*["']\.\.?\//);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/from\s*["']react/);
    const m = await import(/* @vite-ignore */ new URL("../dist/browser/index.js", import.meta.url).href);
    expect(typeof m.QueryCache).toBe("function");
    expect(typeof m.DevtoolsHub).toBe("function");
    expect(m.DEVTOOLS_SCHEMA_VERSION).toBe(1);
  });
});
