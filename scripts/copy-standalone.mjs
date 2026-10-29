/**
 * Copy Next.js static assets into the standalone server output.
 * Cross-platform replacement for `cp -r` (which fails on Windows cmd).
 * Mirrors: cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
 */
import { cpSync, existsSync } from "node:fs";

const pairs = [
  [".next/static", ".next/standalone/.next/static"],
  ["public", ".next/standalone/public"],
];

for (const [src, dest] of pairs) {
  if (!existsSync(src)) {
    console.error(`[copy-standalone] missing "${src}" — run "next build" first`);
    process.exit(1);
  }
  cpSync(src, dest, { recursive: true });
  console.log(`[copy-standalone] copied ${src} -> ${dest}`);
}
