#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Cross-platform replacement for `cmd 2>&1 | tee logfile`.
// usage: node scripts/run-with-log.mjs <logfile> [KEY=VALUE ...] -- <command> [args...]

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const logFile = argv[0];
const envPairs = argv.slice(1, sep).filter((a) => a.includes("="));
const [cmd, ...args] = argv.slice(sep + 1);

if (!logFile || !cmd) {
  console.error("usage: node scripts/run-with-log.mjs <logfile> [KEY=VALUE...] -- <command> [args...]");
  process.exit(1);
}

const logPath = path.resolve(logFile);
const stream = fs.createWriteStream(logPath, { flags: "a" });

const child = spawn(cmd, args, {
  env: Object.assign({}, process.env, Object.fromEntries(envPairs.map((p) => p.split("=")))),
  stdio: ["inherit", "pipe", "pipe"],
  shell: process.platform === "win32",
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  stream.write(chunk);
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  stream.write(chunk);
});

const stop = (signal) => () => {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
  } else {
    child.kill(signal);
  }
  stream.end();
  process.exit(0);
};
process.on("SIGINT", stop("SIGINT"));
process.on("SIGTERM", stop("SIGTERM"));

child.on("error", (err) => {
  console.error(err);
  stream.end();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  stream.end();
  process.exit(code ?? (signal ? 1 : 0));
});
