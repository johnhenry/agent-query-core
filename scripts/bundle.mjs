// Builds dist/browser/index.js: one self-contained, minified ESM file (no imports,
// no React) for vendoring into a page, plus a size table on stdout.
import { build } from "esbuild";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";

const targets = [
  ["unminified", { minify: false, outfile: "dist/browser/index.dev.js" }],
  ["minified", { minify: true, outfile: "dist/browser/index.js" }],
];
const rows = [];
for (const [name, o] of targets) {
  await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    legalComments: "none",
    logLevel: "error",
    ...o,
  });
  const buf = readFileSync(o.outfile);
  rows.push({ build: name, file: o.outfile, raw: statSync(o.outfile).size, gzip: gzipSync(buf).length, brotli: brotliCompressSync(buf).length });
}
console.table(rows);
