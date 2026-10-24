// Reads the store's promotions page live (Settings → Promotions page) for the
// assistant: the text shoppers see, which on themes like Aetrex's lives in the
// page's theme template (templates/page.<suffix>.json, edited in the theme
// editor), not the page's own body. Order: that template, then the page body,
// then the public page. Kept for 15 minutes per shop, so an edit reaches the chat
// within minutes without a resync; a failed read is retried sooner.
import { ADMIN_API_VERSION } from "./admin-api-version.js";
import { htmlToText, parseThemeJson, themeTemplateText } from "./store-knowledge/extract.js";
import { cutPromoSection, pageHandleFromUrl } from "./promo-page.js";

const FRESH_MS = 15 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const cache = new Map(); // `${shop}|${url}|${stop}` → { at, ttl, text }

const PAGE_QUERY = `query PromoPage($q: String!) {
  pages(first: 1, query: $q) { nodes { handle body templateSuffix } }
  themes(first: 1, roles: [MAIN]) { nodes { id } }
}`;
const FILE_QUERY = `query PromoTemplate($id: ID!, $filenames: [String!]) {
  theme(id: $id) { files(filenames: $filenames, first: 1) { nodes { body { ... on OnlineStoreThemeFileBodyText { content } } } } }
}`;

async function adminGql({ shop, accessToken, query, variables, fetchImpl, timeoutMs }) {
  const res = await fetchImpl(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  return (await res.json())?.data || null;
}

// → { template, body }: the text of the page's theme template on the live
// theme (if it has one) and of the page's own body.
async function viaAdmin({ shop, accessToken, handle, fetchImpl, timeoutMs }) {
  const out = { template: "", body: "" };
  if (!shop || !accessToken || !handle) return out;
  const data = await adminGql({ shop, accessToken, query: PAGE_QUERY, variables: { q: `handle:'${handle.replace(/'/g, "")}'` }, fetchImpl, timeoutMs });
  const node = (data?.pages?.nodes || []).find((n) => n?.handle === handle);
  if (!node) return out;
  out.body = node.body ? htmlToText(node.body) : "";
  const suffix = String(node.templateSuffix || "").trim();
  const themeId = data?.themes?.nodes?.[0]?.id;
  if (suffix && themeId) {
    const files = await adminGql({ shop, accessToken, query: FILE_QUERY, variables: { id: themeId, filenames: [`templates/page.${suffix}.json`] }, fetchImpl, timeoutMs }).catch(() => null);
    const content = files?.theme?.files?.nodes?.[0]?.body?.content;
    out.template = content ? themeTemplateText(parseThemeJson(content)) : "";
  }
  return out;
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
    const admin = await viaAdmin({ shop, accessToken, handle, fetchImpl, timeoutMs }).catch(() => ({ template: "", body: "" }));
    text = cutPromoSection(admin.template, stop) || cutPromoSection(admin.body, stop);
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
