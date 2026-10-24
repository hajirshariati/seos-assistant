// Reads the store's promotions page live (Settings → Promotions page) for the
// assistant: through the Admin API (the page as saved in Shopify), else the
// public page. Kept for 15 minutes per shop, so an edit reaches the chat
// within minutes without a resync; a failed read is retried sooner.
import { ADMIN_API_VERSION } from "./admin-api-version.js";
import { htmlToText } from "./store-knowledge/extract.js";
import { cutPromoSection, pageHandleFromUrl } from "./promo-page.js";

const FRESH_MS = 15 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const cache = new Map(); // `${shop}|${url}|${stop}` → { at, ttl, text }

const QUERY = `query PromoPage($q: String!) { pages(first: 1, query: $q) { nodes { handle body } } }`;

async function viaAdmin({ shop, accessToken, handle, fetchImpl, timeoutMs }) {
  if (!shop || !accessToken || !handle) return "";
  const res = await fetchImpl(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query: QUERY, variables: { q: `handle:'${handle.replace(/'/g, "")}'` } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return "";
  const json = await res.json();
  const node = (json?.data?.pages?.nodes || []).find((n) => n?.handle === handle);
  return node?.body ? htmlToText(node.body) : "";
}

async function viaPublicPage({ url, fetchImpl, timeoutMs }) {
  if (!/^https:\/\//i.test(url)) return "";
  const res = await fetchImpl(url, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return "";
  return htmlToText(await res.text());
}

// → the promotions section's text, or "" (no page set, the stop line isn't
// on it, or it couldn't be read — the chat then has no page promotions).
export async function getPagePromos({ shop, accessToken, url, stopLine, fetchImpl = fetch, timeoutMs = 4000, now = Date.now() }) {
  const link = String(url || "").trim();
  const stop = String(stopLine || "").trim();
  if (!link || !stop) return "";
  const key = `${shop}|${link}|${stop}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.text;
  let text = "";
  try {
    const handle = pageHandleFromUrl(link);
    text = cutPromoSection(await viaAdmin({ shop, accessToken, handle, fetchImpl, timeoutMs }).catch(() => ""), stop);
    if (!text) text = cutPromoSection(await viaPublicPage({ url: link, fetchImpl, timeoutMs }).catch(() => ""), stop);
  } catch {
    text = "";
  }
  if (!text && hit?.text) {
    // Couldn't read it this time: keep the last good copy a little longer.
    cache.set(key, { at: now, ttl: RETRY_MS, text: hit.text });
    return hit.text;
  }
  cache.set(key, { at: now, ttl: text ? FRESH_MS : RETRY_MS, text });
  if (!text) console.warn(`[promo-page] ${shop}: no promotions read from ${link} (page unreadable or "${stop}" not found)`);
  return text;
}

export function clearPromoPageCache() {
  cache.clear();
}
