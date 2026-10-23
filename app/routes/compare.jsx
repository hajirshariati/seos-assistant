// Side-by-side comparison for the chat's Compare button: the shopper picks
// 2 or 3 of the product cards they were shown and gets the table straight
// away. No model is involved — every value is the store's own product data
// (app/lib/lean/compare.js), the same table the assistant shows when asked.
//
// Reached through the Shopify app proxy (/apps/hajirai/compare); the proxy
// signature is checked before anything is read.
import { authenticate } from "../shopify.server";
import { checkIpShopRate, clientIp } from "../lib/rate-limit.server.js";
import { loadLeanCatalog } from "../lib/lean/catalog.server.js";
import { buildComparison, comparisonIntro, COMPARE_MAX } from "../lib/lean/compare.js";

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,254}$/i;

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkIpShopRate(session.shop, clientIp(request), { scope: "compare", limit: 30 }).ok) {
    return Response.json({ error: "rate_limited", message: "Please wait a moment and try again." }, { status: 429 });
  }
  const handles = String(new URL(request.url).searchParams.get("handles") || "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => HANDLE_RE.test(h))
    .slice(0, COMPARE_MAX);
  if (handles.length < 2) return Response.json({ error: "pick_two", message: "Pick two or three products to compare." }, { status: 400 });
  try {
    const catalog = await loadLeanCatalog(session.shop);
    const comparison = buildComparison(catalog, handles);
    if (comparison.error) return Response.json({ error: "not_found", message: "Those products aren't available to compare right now." }, { status: 404 });
    return Response.json({ ok: true, intro: comparisonIntro(comparison), comparison }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`[compare] shop=${session.shop} failed: ${err?.message || err}`);
    return Response.json({ error: "failed", message: "The comparison couldn't load right now." }, { status: 500 });
  }
};
