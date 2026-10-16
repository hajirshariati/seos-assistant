// Lean engine — loads and caches the shop's catalog view (see catalog.js).
import prisma from "../../db.server.js";
import { buildLeanCatalog } from "./catalog.js";

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // shop → { at, catalog }

export async function loadLeanCatalog(shop) {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.catalog;
  const rows = await prisma.product.findMany({
    where: { shop, NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } } },
    select: {
      handle: true, title: true, productType: true, tags: true, description: true, status: true,
      featuredImageUrl: true, attributesJson: true,
      variants: { select: { price: true, compareAtPrice: true, inventoryQty: true, optionsJson: true } },
    },
    take: 5000,
  });
  const catalog = buildLeanCatalog(rows, { shop });
  cache.set(shop, { at: Date.now(), catalog });
  console.log(`[lean] catalog loaded shop=${shop} products=${catalog.products.length} categories=${catalog.vocab.categories.length} colors=${catalog.vocab.colors.length}`);
  return catalog;
}
