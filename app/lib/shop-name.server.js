// The store's name from Shopify, cached per store for a few hours.
const cache = new Map();
const TTL_MS = 6 * 3600 * 1000;

export async function getShopName(admin, shop) {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;
  let name = hit?.name || "";
  try {
    const resp = await admin.graphql(`{ shop { name } }`);
    const json = await resp.json();
    const got = json?.data?.shop?.name;
    if (typeof got === "string" && got.trim()) name = got.trim();
  } catch { /* keep the last known name */ }
  cache.set(shop, { name, at: Date.now() });
  return name;
}
