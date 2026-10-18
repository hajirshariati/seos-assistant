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
app.use(morgan("tiny"));
app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));

app.listen(port, () => {
  const ip = Object.values(os.networkInterfaces()).flat().find((i) => String(i?.family).includes("4") && !i.internal)?.address;
  console.log(`[server] http://localhost:${port}${ip ? ` (http://${ip}:${port})` : ""}`);
});
