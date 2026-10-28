// Lean engine — loads and caches the shop's catalog view (see catalog.js).
import prisma from "../../db.server.js";
import { buildLeanCatalog } from "./catalog.js";
import { getSpecRows } from "../product-specs.server.js";

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // shop → { at, catalog }
const loading = new Map(); // shop → promise, so simultaneous chats share one load
const generation = new Map(); // shop → bumped when what the catalog is built from changes

function startLoad(shop) {
  const next = load(shop).finally(() => { if (loading.get(shop) === next) loading.delete(shop); });
  loading.set(shop, next);
  return next;
}

// Past its five minutes, the old copy keeps answering while the new one loads
// in the background: no shopper waits on the reload. Only the very first
// load (or one after a restart) is waited for.
export async function loadLeanCatalog(shop) {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.catalog;
  if (!loading.has(shop)) {
    const next = startLoad(shop);
    // A failed background reload keeps the old copy; the next chat retries.
    if (hit) next.catch((err) => console.error(`[lean] catalog reload failed shop=${shop}:`, err?.message || err));
  }
  return hit ? hit.catalog : loading.get(shop);
}

// The spec sheet changed: build the catalog again now and return it. Chats
// meanwhile keep the current copy; a load already under way read the old
// sheet, so it isn't kept. (Other servers pick it up within five minutes.)
export function reloadLeanCatalog(shop) {
  generation.set(shop, (generation.get(shop) || 0) + 1);
  const hit = cache.get(shop);
  if (hit) hit.at = 0;
  return startLoad(shop);
}

async function load(shop) {
  const gen = generation.get(shop) || 0;
  const specRows = await getSpecRows(shop);
  const rows = await prisma.product.findMany({
    where: { shop, NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } } },
    select: {
      handle: true, title: true, productType: true, tags: true, description: true, status: true,
      featuredImageUrl: true, attributesJson: true,
      variants: { select: { sku: true, price: true, compareAtPrice: true, inventoryQty: true, optionsJson: true } },
    },
    // Newest first, so a store past the limit loses its oldest products, not random ones.
    orderBy: { updatedAt: "desc" },
    take: 10000,
  });
  const catalog = buildLeanCatalog(rows, { shop, specRows });
  if ((generation.get(shop) || 0) === gen) cache.set(shop, { at: Date.now(), catalog });
  const sr = catalog.specReport;
  console.log(`[lean] catalog loaded shop=${shop} products=${catalog.products.length} categories=${catalog.vocab.categories.length} colors=${catalog.vocab.colors.length}${sr ? ` specs=${sr.byCode}+${sr.byStyle}/${sr.products}` : ""}`);
  return catalog;
}
