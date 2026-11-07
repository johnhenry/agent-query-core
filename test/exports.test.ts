import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("package exports", () => {
  it("every subpath declares types and a default", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { exports: Record<string, { types?: string; default?: string }> };
    for (const [k, v] of Object.entries(pkg.exports)) {
      expect(v.types, `${k} types`).toBeTruthy();
      expect(v.default, `${k} default`).toBeTruthy();
    }
  });
});
