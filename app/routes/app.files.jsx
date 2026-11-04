// Settings → Choose from files: a page of the store's Shopify Files
// (pictures, videos or both), searched by name — JSON for the picker.
// A resource route: only a loader, no page.
import { requireFullAccess } from "../lib/staff-access.server";
import { listShopFiles } from "../lib/shop-files.server";

export const loader = async ({ request }) => {
  const { admin } = await requireFullAccess(request);
  const url = new URL(request.url);
  try {
    const out = await listShopFiles(admin, { kind: url.searchParams.get("kind") || "all", words: url.searchParams.get("q") || "", after: url.searchParams.get("after") || "" });
    return Response.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[files] listing failed:", err?.message || err);
    return Response.json({ error: "Your files couldn't be read just now. Try again in a moment." }, { status: 502 });
  }
};
