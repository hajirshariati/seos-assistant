import prisma from "../db.server";
import { extractEnrichmentRows } from "../lib/csv.server";

export async function upsertEnrichmentsFromCsv(shop, file, content) {
  const extracted = extractEnrichmentRows(content);
  if (!extracted) {
    return { matched: 0, total: 0, skuColumn: null, noSkuColumn: true };
  }
  const sourceFileId = file?.id || null;
  const sourceFileType = file?.fileType || null;
  if (sourceFileId) {
    await prisma.productEnrichment.deleteMany({ where: { shop, sourceFileId } });
  }
  const skus = extracted.rows.map((r) => r.sku);
  const matching = skus.length
    ? await prisma.productVariant.findMany({
        where: { sku: { in: skus }, product: { shop } },
        select: { sku: true },
      })
    : [];
  const matchedSkus = new Set(matching.map((v) => v.sku));
  for (const { sku, data } of extracted.rows) {
    await prisma.productEnrichment.upsert({
      where: { shop_sku: { shop, sku } },
      update: { data, sourceFileId, sourceFileType, updatedAt: new Date() },
      create: { shop, sku, data, sourceFileId, sourceFileType },
    });
  }
  return { matched: matchedSkus.size, total: extracted.rows.length, skuColumn: extracted.skuColumn };
}

export async function deleteEnrichmentsBySourceFile(shop, sourceFileId) {
  if (!shop || !sourceFileId) return { count: 0 };
  return prisma.productEnrichment.deleteMany({ where: { shop, sourceFileId } });
}

export async function countEnrichmentsByShop(shop) {
  return prisma.productEnrichment.count({ where: { shop } });
}

export async function countEnrichmentsBySourceFile(sourceFileId) {
  if (!sourceFileId) return 0;
  return prisma.productEnrichment.count({ where: { sourceFileId } });
}

