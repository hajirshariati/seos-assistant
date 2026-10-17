// Liveness + database check behind /healthz.
import prisma from "../db.server";
import { APP_COMMIT } from "./app-version.server";

const startedAt = Date.now();

export async function healthCheck() {
  const t0 = Date.now();
  let db = "ok";
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
  } catch {
    db = "down";
  }
  const ok = db === "ok";
  return Response.json(
    { ok, db, dbMs: Date.now() - t0, commit: APP_COMMIT, uptimeS: Math.round((Date.now() - startedAt) / 1000) },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
