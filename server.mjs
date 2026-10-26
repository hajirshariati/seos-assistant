// Production server — react-router-serve's setup (compression, cached
// assets, request log) plus one change: trust the host's proxy headers.
//
// Railway (like most hosts) ends HTTPS at its proxy and forwards plain HTTP.
// Without trusting X-Forwarded-Proto, every request looks like http://…
// while the browser's Origin is https://…, and React Router's cross-site
// check rejects every admin form submit with 400 Bad Request.
import path from "node:path";
import process from "node:process";
import os from "node:os";
import express from "express";
import compression from "compression";
import morgan from "morgan";
import { createRequestHandler } from "@react-router/express";

const build = await import(path.resolve("build/server/index.js"));
const port = Number(process.env.PORT) || 3000;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(compression());
app.use("/assets", express.static("build/client/assets", { immutable: true, maxAge: "1y" }));
app.use(express.static("build/client"));
app.use(express.static("public", { maxAge: "1h" }));
// The request log keeps the path only: app-proxy and admin query strings
// carry signatures, session tokens and the signed-in customer's id.
morgan.token("path", (req) => String(req.originalUrl || req.url || "").split("?")[0]);
// widget-config is fetched on every storefront page view: it's left out of
// the request log unless it fails.
app.use(morgan(":method :path :status :res[content-length] - :response-time ms", {
  skip: (req, res) => res.statusCode < 400 && String(req.originalUrl || req.url || "").startsWith("/widget-config"),
}));
app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));

const server = app.listen(port, () => {
  const ip = Object.values(os.networkInterfaces()).flat().find((i) => String(i?.family).includes("4") && !i.internal)?.address;
  console.log(`[server] http://localhost:${port}${ip ? ` (http://${ip}:${port})` : ""}`);
});

// A deploy stops this server with SIGTERM: take no new requests, let the ones
// in flight finish (a chat reply can take up to ~75s), then exit. The host
// has to allow that long before it force-stops the old server (Railway:
// RAILWAY_DEPLOYMENT_DRAINING_SECONDS).
const GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 80_000;
let stopping = false;
const shutdown = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`[server] ${signal}: finishing requests in flight (up to ${Math.round(GRACE_MS / 1000)}s)`);
  server.close(() => {
    console.log("[server] all requests finished — exiting");
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), GRACE_MS).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
