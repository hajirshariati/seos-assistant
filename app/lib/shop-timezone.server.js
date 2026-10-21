import { dayKeyIn } from "./store-day.js";

// The store's time zone from Shopify, cached per store for a few hours.
const cache = new Map();
const TTL_MS = 6 * 3600 * 1000;

export async function getShopTimeZone(admin, shop) {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tz;
  let tz = hit?.tz || "";
  try {
    const resp = await admin.graphql(`{ shop { ianaTimezone } }`);
    const json = await resp.json();
    const got = json?.data?.shop?.ianaTimezone;
    if (got && dayKeyIn(got)(new Date()).length === 10) tz = got;
  } catch { /* keep the last known zone, or UTC */ }
  cache.set(shop, { tz, at: Date.now() });
  return tz;
}
