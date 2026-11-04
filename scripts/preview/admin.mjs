// Admin preview: renders an admin route on the server, with its real loader
// against the local test database (seeded by seed.mjs), and screenshots it.
//
//   node scripts/preview/admin.mjs /app/recordings out/recordings.png [--width 1280]
//   node scripts/preview/admin.mjs "/app/exports?section=flagged" out/flagged.md   (a download: its body)
//
// App Bridge and the admin session are stood in for (stubs/); everything
// else is the app's own code, loaded through Vite so the JSX and the
// .server imports resolve as they do in the app.
import { createServer } from "vite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [routePath = "/app/recordings", out = "preview.png", ...rest] = process.argv.slice(2);
const width = Number((rest.find((a) => a.startsWith("--width=")) || "--width=1280").slice(8));
process.env.NODE_ENV ||= "development";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.ENCRYPTION_KEY ||= "0".repeat(64);

const stubs = {
  "@shopify/app-bridge-react": path.join(root, "scripts/preview/stubs/app-bridge-react.js"),
  "staff-access.server": path.join(root, "scripts/preview/stubs/staff-access.server.js"),
};
const vite = await createServer({
  configFile: false,
  root,
  logLevel: "error",
  server: { middlewareMode: true, hmr: false, fs: { allow: [root] } },
  appType: "custom",
  esbuild: { jsx: "automatic" },
  ssr: { external: ["@anthropic-ai/sdk", "@prisma/client"] },
  plugins: [{
    name: "preview-stubs",
    enforce: "pre",
    resolveId(id) {
      if (id === "@shopify/app-bridge-react") return stubs["@shopify/app-bridge-react"];
      if (/(^|\/)staff-access\.server(\.js)?$/.test(id)) return stubs["staff-access.server"];
      return null;
    },
  }],
});
try {
  const file = { "/app/recordings": "app/routes/app.recordings.jsx", "/app/analytics": "app/routes/app.analytics.jsx", "/app": "app/routes/app._index.jsx", "/app/exports": "app/routes/app.exports.jsx" }[routePath.split("?")[0]];
  if (!file) throw new Error(`no route file for ${routePath}`);
  const mod = await vite.ssrLoadModule(path.join(root, file));
  const { rr, polaris, React, renderToString } = await vite.ssrLoadModule(path.join(root, "scripts/preview/libs.js"));
  const en = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@shopify/polaris/locales/en.json"), "utf8"));
  const routes = [{
    id: "routes/app", path: "/app", loader: () => ({ apiKey: "", appName: "AVA", access: "full" }), Component: rr.Outlet,
    children: [{ path: routePath.split("?")[0].replace(/^\/app\/?/, ""), index: routePath.split("?")[0] === "/app", loader: mod.loader, action: mod.action, Component: mod.default }],
  }];
  const handler = rr.createStaticHandler(routes);
  // A download (the exports route): its body is written to `out` as is.
  if (!out.endsWith(".png")) {
    const res = await handler.queryRoute(new Request(`http://localhost${routePath}`));
    if (!(res instanceof Response)) throw new Error("the route gave data, not a file");
    if (!res.ok) throw new Error(`the export answered ${res.status}: ${await res.text()}`);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, await res.text());
    console.log(`${out} (${res.headers.get("Content-Disposition") || res.headers.get("Content-Type")})`);
  } else {
  const context = await handler.query(new Request(`http://localhost${routePath}`));
  if (context instanceof Response) throw new Error(`the loader answered ${context.status}`);
  if (context.errors) throw Object.values(context.errors)[0];
  const router = rr.createStaticRouter(handler.dataRoutes, context);
  const html = renderToString(React.createElement(polaris.AppProvider, { i18n: en }, React.createElement(rr.StaticRouterProvider, { router, context, hydrate: false })));
  const css = fs.readFileSync(path.join(root, "node_modules/@shopify/polaris/build/esm/styles.css"), "utf8");
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>body{margin:0;background:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,"San Francisco","Segoe UI",Roboto,Helvetica,Arial,sans-serif}.frame{padding:16px 20px 40px}</style></head><body><div class="frame">${html}</div></body></html>`;
  const htmlOut = out.replace(/\.png$/, ".html");
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(htmlOut, page);
  const browser = await chromium.launch();
  const bp = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await bp.goto(`file://${path.resolve(htmlOut)}`);
  await bp.waitForTimeout(400); // past any entrance animation
  await bp.screenshot({ path: out, fullPage: true });
  const h = await bp.evaluate(() => document.documentElement.scrollHeight);
  await browser.close();
  console.log(`${out} (${width}×${h})`);
  }
} catch (err) {
  console.error(err?.stack || err);
  process.exitCode = 1;
} finally {
  await vite.close();
  process.exit(process.exitCode || 0);
}
