/**
 * Copy Next.js static assets into the standalone server output, verify the
 * Prisma query engine made it through tracing, and stage the whole server
 * into src-tauri/resources/app so the Tauri bundler ships it INSIDE the
 * installer (this is what makes Nook self-contained — no Node.js, no dev
 * server, no "127.0.0.1 refused to connect").
 *
 * Mirrors: cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
 * Then:    robocopy .next/standalone src-tauri/resources/app /MIR (cross-platform)
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const pairs = [
  [".next/static", ".next/standalone/.next/static"],
  ["public", ".next/standalone/public"],
];

for (const [src, dest] of pairs) {
  if (!existsSync(join(root, src))) {
    console.error(`[copy-standalone] missing "${src}" — run "next build" first`);
    process.exit(1);
  }
  cpSync(join(root, src), join(root, dest), { recursive: true });
  console.log(`[copy-standalone] copied ${src} -> ${dest}`);
}

// --- sanity: the Prisma query engine must be in the standalone trace ---
// NOTE: on Windows CI, Next.js output file tracing does NOT pick up the
// engine .node file (it works on Linux), so we copy it in explicitly.
const engineDir = join(root, ".next/standalone/node_modules/.prisma/client");
const engineSources = [
  join(root, "node_modules/.prisma/client"),
  join(root, "node_modules/@prisma/engines"),
];
function findEngines(dir) {
  try {
    return readdirSync(dir).filter((f) => f.startsWith("libquery_engine-")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}
let engines = findEngines(engineDir);
if (engines.length === 0) {
  // copy from the root install into the standalone client dir
  const found = engineSources.flatMap(findEngines);
  if (found.length > 0) {
    mkdirSync(engineDir, { recursive: true });
    for (const f of found) {
      cpSync(f, join(engineDir, f.split(/[\\/]/).pop()));
    }
    engines = findEngines(engineDir);
    console.log(`[copy-standalone] copied missing prisma engine into standalone: ${engines.map((f) => f.split(/[\\/]/).pop()).join(", ")}`);
  }
}
if (engines.length === 0) {
  console.warn("[copy-standalone] WARNING: no Prisma query engine in standalone output — DB will fail at runtime!");
} else {
  console.log(`[copy-standalone] prisma engine ok: ${engines.map((f) => f.split(/[\\/]/).pop()).join(", ")}`);
}

// --- stage the standalone server into the Tauri bundle resources ---
const stageDir = join(root, "src-tauri", "resources", "app");
const srcDir = join(root, ".next", "standalone");
if (existsSync(join(root, "src-tauri"))) {
  console.log(`[copy-standalone] staging ${srcDir} -> ${stageDir} (this powers the installer)`);
  rmSync(stageDir, { recursive: true, force: true });
  cpSync(srcDir, stageDir, { recursive: true });
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const sizeOf = (p) => {
    let total = 0;
    try {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        const full = join(p, entry.name);
        total += entry.isDirectory() ? sizeOf(full) : statSync(full).size;
      }
    } catch { /* unreadable entry — skip */ }
    return total;
  };
  console.log(`[copy-standalone] staged app size: ${mb(sizeOf(stageDir))}`);
} else {
  console.log("[copy-standalone] no src-tauri dir — skipping desktop staging (web-only build)");
}
