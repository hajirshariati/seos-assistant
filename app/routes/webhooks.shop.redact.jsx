import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}. Deleting all shop data.`);

  await Promise.all([
    db.knowledgeFile.deleteMany({ where: { shop } }),
    db.shopConfig.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
    db.product.deleteMany({ where: { shop } }),
    db.attributeMapping.deleteMany({ where: { shop } }),
    db.catalogSyncState.deleteMany({ where: { shop } }),
    db.productEnrichment.deleteMany({ where: { shop } }),
    db.chatUsage.deleteMany({ where: { shop } }),
    db.chatFeedback.deleteMany({ where: { shop } }),
    db.chatProductMention.deleteMany({ where: { shop } }),
    db.catalogFact.deleteMany({ where: { shop } }),
    db.catalogFacetIndex.deleteMany({ where: { shop } }),
    // Every shop-scoped table — ChatConversion holds a Shopify
    // customerId, so leaving it behind is a privacy-compliance gap;
    // the rest were added after the original delete list and drifted.
    // (ProductVariant cascades from Product.)
    db.chatConversion.deleteMany({ where: { shop } }),
    db.campaign.deleteMany({ where: { shop } }),
    db.decisionTree.deleteMany({ where: { shop } }),
    db.knowledgeChunk.deleteMany({ where: { shop } }),
    db.claimRule.deleteMany({ where: { shop } }),
    db.categoryGroup.deleteMany({ where: { shop } }),
    db.colorFamily.deleteMany({ where: { shop } }),
    db.productViewerPing.deleteMany({ where: { shop } }),
    db.recentPurchase.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
