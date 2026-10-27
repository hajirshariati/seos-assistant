// "View all" pages: the chat's View all sheet shows a search's matches a page
// at a time. The first page comes with the reply; the sheet asks here for the
// others, sending the same search back. No model is involved — the same
// in-memory catalog search the assistant used, ranked the same way.
//
// Reached through the Shopify app proxy (/apps/hajirai/view-all); the proxy
// signature is checked before anything is read.
import { authenticate } from "../shopify.server";
import { checkIpShopRate, clientIp } from "../lib/rate-limit.server.js";
import { loadLeanCatalog } from "../lib/lean/catalog.server.js";
import { cleanViewAllSearch } from "../lib/lean/shop-all.js";
import { viewAllPage } from "../lib/lean/engine.js";
import { getShopConfigCached } from "../models/ShopConfig.server";
import { seasonalCollection } from "../lib/seasonal-cta.js";
import { featuredCollection, collectionView } from "../lib/lean/collections.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkIpShopRate(session.shop, clientIp(request), { scope: "view-all", limit: 60 }).ok) {
    return Response.json({ error: "rate_limited", message: "Please wait a moment and try again." }, { status: 429 });
  }
  const params = new URL(request.url).searchParams;
  let raw = null;
  try { raw = JSON.parse(String(params.get("search") || "").slice(0, 2000)); } catch { /* handled below */ }
  const search = cleanViewAllSearch(raw);
  if (!search) return Response.json({ error: "bad_search", message: "This list can't be loaded." }, { status: 400 });
  try {
    let catalog = await loadLeanCatalog(session.shop);
    // A list from the seasonal button: its collection's products (only the
    // collection the store has on the button is ever read).
    if (search.collection) {
      const seasonal = seasonalCollection(await getShopConfigCached(session.shop));
      if (seasonal?.handle === search.collection) {
        const read = await featuredCollection({ shop: session.shop, accessToken: session.accessToken, handle: seasonal.handle }).catch(() => null);
        const view = collectionView(read, catalog);
        if (view) catalog = { ...catalog, collections: new Map([[seasonal.handle, view]]) };
      }
    }
    const result = viewAllPage(catalog, search, params.get("page"));
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`[view-all] shop=${session.shop} failed: ${err?.message || err}`);
    return Response.json({ error: "failed", message: "This page couldn't load right now." }, { status: 500 });
  }
};
