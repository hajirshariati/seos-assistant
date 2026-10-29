// What the app needs to know from Shopify about the store and about itself:
// the shop's ID and currency (AVA's Shopify Analytics events), and the app's
// handle and name (the events' prefix; the name the admin shows, and the
// brand of the chat's order tags). Read from the Admin API at most once an
// hour per store, and kept with the store's settings so a restart doesn't
// read it again. When Shopify can't be reached, the last copy is used.
import prisma from "../db.server.js";
import { forgetShopConfig } from "../models/ShopConfig.server.js";

// Read again after an hour, so a new app name shows within the hour.
const FRESH_MS = 60 * 60 * 1000;
// After Shopify couldn't be reached, wait this long before trying again.
const RETRY_LATER_MS = 10 * 60 * 1000;

const QUERY = "query AppShopFacts { shop { id currencyCode } currentAppInstallation { app { handle title } } }";

export function parseShopFacts(raw) {
  try {
    const f = JSON.parse(raw || "");
    return f && typeof f.id === "string" && typeof f.handle === "string" && Number.isFinite(f.at) ? f : null;
  } catch {
    return null;
  }
}

const cache = new Map(); // shop → { facts, at } | { facts (last copy or null), failedAt }
let serverName = null; // { name, at }
let lastWarn = 0;

async function readFromShopify(shop, admin) {
  let client = admin;
  if (!client) {
    const { unauthenticated } = await import("../shopify.server");
    client = (await unauthenticated.admin(shop)).admin;
  }
  const res = await client.graphql(QUERY);
  const json = await res.json();
  const id = json?.data?.shop?.id;
  const app = json?.data?.currentAppInstallation?.app;
  if (typeof id !== "string" || typeof app?.handle !== "string") throw new Error("shop or app missing");
  return { id, handle: app.handle, title: String(app.title || ""), currency: String(json.data.shop.currencyCode || ""), at: Date.now() };
}

// The store's facts, or null when there's never been a copy. `config` is the
// store's settings (for the kept copy); `admin`, a client to read with when
// the caller has one (a webhook's), else the store's offline session's.
export async function shopFacts(shop, config, { admin = null } = {}) {
  const hit = cache.get(shop);
  if (hit?.at && Date.now() - hit.at < FRESH_MS) return hit.facts;
  if (hit?.failedAt && Date.now() - hit.failedAt < RETRY_LATER_MS) return hit.facts;
  const saved = parseShopFacts(config?.appEventsShop);
  if (saved && typeof saved.title === "string" && Date.now() - saved.at < FRESH_MS) {
    cache.set(shop, { facts: saved, at: saved.at });
    return saved;
  }
  try {
    const facts = await readFromShopify(shop, admin);
    cache.set(shop, { facts, at: facts.at });
    await prisma.shopConfig.updateMany({ where: { shop }, data: { appEventsShop: JSON.stringify(facts) } });
    forgetShopConfig(shop);
    return facts;
  } catch (err) {
    const last = hit?.facts || saved || null;
    cache.set(shop, { facts: last, failedAt: Date.now() });
    if (Date.now() - lastWarn > 60_000) {
      lastWarn = Date.now();
      console.warn(`[shopify-facts] couldn't read ${shop} from Shopify${last ? " (using the last copy)" : ""}: ${err?.message || err}`);
    }
    return last;
  }
}

// The app this server runs, by its name in Shopify — from the stores' kept
// copies (a server runs one app). For the pages no store opens: the privacy
// policy, the setup guide. "" until a store's copy has it; kept 10 minutes.
export async function serverAppName() {
  if (serverName && Date.now() - serverName.at < 10 * 60 * 1000) return serverName.name;
  let name = "";
  try {
    const rows = await prisma.shopConfig.findMany({
      where: { appEventsShop: { not: "" } },
      select: { appEventsShop: true },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });
    for (const r of rows) {
      const t = parseShopFacts(r.appEventsShop)?.title;
      if (typeof t === "string" && t.trim()) { name = t.trim(); break; }
    }
  } catch {
    name = serverName?.name || "";
  }
  serverName = { name, at: Date.now() };
  return name;
}
