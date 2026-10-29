import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

function resolveDatabaseUrl(): string {
  // Allow explicit override (local dev, or a hosted DB).
  if (process.env.DATABASE_URL && !process.env.VERCEL) {
    return process.env.DATABASE_URL;
  }

  // On Vercel the filesystem is read-only except /tmp. Copy the bundled,
  // pre-seeded SQLite database there on first use so the app can read and write.
  if (process.env.VERCEL) {
    const tmpDb = "/tmp/custom.db";
    if (!fs.existsSync(tmpDb)) {
      const bundled = path.join(process.cwd(), "prisma", "custom.db");
      if (fs.existsSync(bundled)) {
        try {
          fs.copyFileSync(bundled, tmpDb);
        } catch {
          // fall through; Prisma will surface the error if it cannot open the file
        }
      }
    }
    return `file:${tmpDb}`;
  }

  // Local fallback: absolute path so resolution does not depend on cwd.
  const localDb = path.join(process.cwd(), "prisma", "custom.db");
  return `file:${localDb}`;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: resolveDatabaseUrl() } },
    log: ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
