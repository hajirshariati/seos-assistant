// The products in the seasonal button's collection, read from Shopify (the
// synced catalog doesn't keep collections). Kept 10 minutes per shop and
// collection, served while a fresh copy loads, so a busy day reads Shopify a
// few times an hour — not per chat. A failed read keeps the last good copy
// and tries again in a minute.
import { ADMIN_API_VERSION } from "../admin-api-version.js";
import { productKind } from "./catalog.js";

const FRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const MAX_PAGES = 8; // 2,000 products — far beyond a seasonal collection
const cache = new Map(); // `${shop}|${handle}` → { at, ttl, value, pending }

const QUERY = `query SeasonalProducts($handle: String!, $cursor: String) {
  collectionByIdentifier(identifier: { handle: $handle }) {
    title
    products(first: 250, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { handle } }
  }
}`;

// → { title, handles: [...] } in the collection's own order, or null when
// the store has no such collection. Throws when Shopify can't be read.
export async function readCollection({ shop, accessToken, handle, fetchImpl = fetch, timeoutMs = 8000 }) {
  const handles = [];
  let title = "";
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query: QUERY, variables: { handle, cursor } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Shopify answered ${res.status}`);
    const json = await res.json();
    if (json?.errors?.length) throw new Error(json.errors.map((e) => e?.message).join("; "));
    const c = json?.data?.collectionByIdentifier;
    if (!c) return null;
    title = c.title || title;
    for (const n of c.products?.nodes || []) if (n?.handle) handles.push(n.handle);
    if (!c.products?.pageInfo?.hasNextPage) break;
    cursor = c.products.pageInfo.endCursor;
  }
  return { title, handles };
}

// The collection as the search uses it: its products (and their place in
// the collection's own order), and whether to keep to its footwear — the
// button shows footwear, unless the collection has none.
export function collectionView(read, catalog) {
  if (!read) return null;
  const order = new Map(read.handles.map((h, i) => [h, i]));
  const products = (catalog?.products || []).filter((p) => order.has(p.handle));
  return { title: read.title, order, footwearOnly: products.some((p) => productKind(p) === "footwear") };
}

export async function featuredCollection({ shop, accessToken, handle, fetchImpl = fetch, now = Date.now() }) {
  if (!shop || !handle || !accessToken) return null;
  const key = `${shop}|${handle}`;
  const hit = cache.get(key);
  const load = () => {
    if (hit?.pending) return hit.pending;
    const entry = hit || {};
    entry.pending = readCollection({ shop, accessToken, handle, fetchImpl })
      .then((value) => { Object.assign(entry, { at: Date.now(), ttl: FRESH_MS, value }); return value; })
      .catch((err) => {
        console.error(`[collections] ${shop} ${handle}: ${err?.message || err}`);
        // Nothing read yet counts as "no collection" until the retry.
        Object.assign(entry, { at: Date.now(), ttl: RETRY_MS, value: entry.value ?? null });
        return entry.value;
      })
      .finally(() => { entry.pending = null; });
    cache.set(key, entry);
    return entry.pending;
  };
  if (hit && "value" in hit) {
    if (now - hit.at > hit.ttl) load(); // fresh copy in the background
    return hit.value;
  }
  return load();
}

export function forgetCollections() {
  cache.clear();
}
