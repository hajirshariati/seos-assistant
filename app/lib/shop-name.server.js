// The store's name and web addresses from Shopify, cached per store for a
// few hours.
const cache = new Map();
const TTL_MS = 6 * 3600 * 1000;

async function shopFacts(admin, shop) {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  let name = hit?.name || "";
  let hosts = hit?.hosts || [];
  try {
    const resp = await admin.graphql(`{ shop { name myshopifyDomain primaryDomain { host } } }`);
    const json = await resp.json();
    const s = json?.data?.shop;
    if (typeof s?.name === "string" && s.name.trim()) name = s.name.trim();
    const got = [s?.primaryDomain?.host, s?.myshopifyDomain].filter((h) => typeof h === "string" && h);
    if (got.length) hosts = got;
  } catch { /* keep the last known facts */ }
  const facts = { name, hosts, at: Date.now() };
  cache.set(shop, facts);
  return facts;
}

export async function getShopName(admin, shop) {
  return (await shopFacts(admin, shop)).name;
}

// The store's own domains (its primary domain, then its myshopify one).
export async function getShopHosts(admin, shop) {
  const hosts = (await shopFacts(admin, shop)).hosts;
  return hosts.includes(shop) ? hosts : [...hosts, shop];
}
