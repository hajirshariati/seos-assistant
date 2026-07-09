import { useEffect, useState, useCallback, useRef } from "react";
import {
  useLoaderData,
  useActionData,
  useFetcher,
  useRevalidator,
  useNavigation,
  useSubmit,
} from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Banner,
  Box,
  Divider,
  FormLayout,
  TextField,
  Select,
  Tag,
  Checkbox,
  DataTable,
  DropZone,
  EmptyState,
  ProgressBar,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getCatalogSyncState,
  getProductCount,
  syncCatalogAsync,
  stopCatalogSync,
} from "../models/Product.server";
import {
  getAttributeMappings,
  upsertAttributeMapping,
  deleteAttributeMapping,
} from "../models/AttributeMapping.server";
import {
  listCampaigns,
  saveCampaign,
  deleteCampaign,
  findUnknownSkus,
  CAMPAIGN_TEMPLATE,
} from "../models/Campaign.server";
import {
  getShopConfig,
  updateShopConfig,
  getKnowledgeFiles,
  saveKnowledgeFile,
  deleteKnowledgeFile,
  getKnowledgeFileForDownload,
} from "../models/ShopConfig.server";
import prisma from "../db.server";
import { backfillShopEmbeddings, resolveShopEmbedding } from "../lib/embeddings.server";
import { rebuildChunksForFile } from "../lib/knowledge-chunks.server";
import {
  upsertEnrichmentsFromCsv,
  deleteEnrichmentsBySourceFile,
  countEnrichmentsBySourceFile,
} from "../models/ProductEnrichment.server";
import { getShopPlan } from "../lib/billing.server";
import { PlanGate } from "../components/PlanGate";
import {
  listDecisionTrees,
  getDecisionTreeById,
  getDecisionTreeByIntent,
  saveDecisionTree,
  deleteDecisionTree,
} from "../models/DecisionTree.server";
import { validateDecisionTree } from "../lib/decision-tree-schema.server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import BrandHeader from "../components/BrandHeader";
import { nextScheduledSyncAt } from "../lib/catalog-sync-scheduler.server";

function isCsv(fileName) {
  return typeof fileName === "string" && fileName.toLowerCase().endsWith(".csv");
}

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw || "");
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [state, count, mappings, config, files, plan, campaigns, decisionTrees] = await Promise.all([
    getCatalogSyncState(session.shop),
    getProductCount(session.shop),
    getAttributeMappings(session.shop),
    getShopConfig(session.shop),
    getKnowledgeFiles(session.shop),
    getShopPlan(session.shop),
    listCampaigns(session.shop),
    listDecisionTrees(session.shop),
  ]);
  const enrichedCounts = await Promise.all(files.map((f) => countEnrichmentsBySourceFile(f.id)));
  const filesWithCounts = files.map((f, i) => ({ ...f, enrichedSkus: enrichedCounts[i] }));

  // Embedding status: how many products have been embedded?
  let embeddedCount = 0;
  let embeddingProvider = config.embeddingProvider || "";
  if (embeddingProvider) {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "Product" WHERE shop = $1 AND embedding IS NOT NULL`,
        session.shop,
      );
      embeddedCount = rows?.[0]?.n || 0;
    } catch { /* migration not yet applied; fall through */ }
  }

  return {
    shop: session.shop,
    status: state.status,
    lastSyncedAt: state.lastSyncedAt,
    nextScheduledSyncAt: nextScheduledSyncAt().toISOString(),
    lastError: state.lastError,
    productsCount: count,
    syncedSoFar: state.syncedSoFar || 0,
    mappings,
    categoryExclusions: safeParse(config.categoryExclusions, []),
    categoryGroups: safeParse(config.categoryGroups, []),
    embeddingProvider,
    embeddedCount,
    querySynonyms: safeParse(config.querySynonyms, []),
    similarMatchAttributes: safeParse(config.similarMatchAttributes, []),
    collectionLinks: safeParse(config.collectionLinks, []),
    fitPredictorEnabled: config.fitPredictorEnabled === true,
    fitPredictorConfig: (() => {
      try {
        const v = JSON.parse(config.fitPredictorConfig || "{}");
        return v && typeof v === "object" ? v : {};
      } catch { return {}; }
    })(),
    deduplicateColors: config.deduplicateColors,
    productCardStyle: config.productCardStyle === "showcase" ? "showcase" : "horizontal",
    knowledgeRagEnabled: config.knowledgeRagEnabled === true,
    files: filesWithCounts,
    plan: { id: plan.id, name: plan.name, features: plan.features, knowledgeFiles: plan.knowledgeFiles },
    campaigns: campaigns.map((c) => ({
      ...c,
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt.toISOString(),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    campaignTemplate: CAMPAIGN_TEMPLATE,
    campaignCheatCode: config.campaignCheatCode || "",
    decisionTreeEnabled: config.decisionTreeEnabled === true,
    decisionTrees: decisionTrees.map((t) => ({
      ...t,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
      updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : t.updatedAt,
    })),
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "resync") {
    syncCatalogAsync(admin, session.shop);
    return { started: true };
  }

  if (intent === "stop_sync") {
    await stopCatalogSync(session.shop);
    return { stopped: true };
  }

  if (intent === "backfill_embeddings") {
    const config = await getShopConfig(session.shop);
    const resolved = resolveShopEmbedding(config);
    if (!resolved) {
      return { error: "Configure an embedding provider and API key in Settings first." };
    }
    try {
      const result = await backfillShopEmbeddings(prisma, session.shop, config);
      return { backfilled: true, ...result };
    } catch (err) {
      return { error: `Backfill failed: ${err?.message || "unknown error"}` };
    }
  }

  if (intent === "clear_and_reembed") {
    const config = await getShopConfig(session.shop);
    const resolved = resolveShopEmbedding(config);
    if (!resolved) {
      return { error: "Configure an embedding provider and API key in Settings first." };
    }
    try {
      // Wipe all embeddings, then re-run backfill on the fresh catalog data.
      // Use this when catalog metadata changed (new attribute mappings,
      // metaobject scope granted after initial embed, bulk re-tagged
      // products) so embeddings reflect the current data.
      await prisma.$executeRawUnsafe(
        `UPDATE "Product" SET embedding = NULL, "embeddingUpdatedAt" = NULL WHERE shop = $1`,
        session.shop,
      );
      const result = await backfillShopEmbeddings(prisma, session.shop, config);
      return { reembedded: true, ...result };
    } catch (err) {
      return { error: `Re-embed failed: ${err?.message || "unknown error"}` };
    }
  }

  if (intent === "save_mapping") {
    const attribute = String(formData.get("attribute") || "").trim().toLowerCase();
    const sourceType = String(formData.get("sourceType") || "metafield");
    const target = String(formData.get("target") || "product");
    const namespace = String(formData.get("namespace") || "").trim();
    const key = String(formData.get("key") || "").trim();
    const prefix = String(formData.get("prefix") || "").trim();

    if (!attribute) return { error: "Attribute name is required." };
    if (sourceType === "metafield") {
      if (!namespace || !key) return { error: "Namespace and key are required for metafield mappings." };
    } else if (sourceType === "tag_prefix") {
      if (!prefix) return { error: "Prefix is required for tag prefix mappings." };
    } else {
      return { error: "Unknown source type." };
    }

    await upsertAttributeMapping(session.shop, {
      attribute,
      sourceType,
      target,
      namespace: sourceType === "metafield" ? namespace : null,
      key: sourceType === "metafield" ? key : null,
      prefix: sourceType === "tag_prefix" ? prefix : null,
    });
    // Mapping change means existing embeddings are stale (their attribute
    // text no longer reflects the new mapping). Clear them; the next
    // backfill or webhook update will recreate with fresh data.
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "Product" SET embedding = NULL, "embeddingUpdatedAt" = NULL WHERE shop = $1`,
        session.shop,
      );
    } catch { /* table might not have the column on shops without semantic search */ }
    return { saved: true, embeddingsStale: true };
  }

  if (intent === "delete_mapping") {
    const attribute = String(formData.get("attribute") || "").trim();
    if (attribute) await deleteAttributeMapping(session.shop, attribute);
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "Product" SET embedding = NULL, "embeddingUpdatedAt" = NULL WHERE shop = $1`,
        session.shop,
      );
    } catch { /* */ }
    return { deleted: true, embeddingsStale: true };
  }

  if (intent === "toggle_dedup") {
    const value = formData.get("deduplicateColors") === "true";
    await updateShopConfig(session.shop, { deduplicateColors: value });
    return { saved: true };
  }

  if (intent === "set_card_style") {
    const raw = String(formData.get("productCardStyle") || "horizontal");
    // Whitelist values — anything else falls back to the default so a
    // bad form post can't put an unknown string in the DB and break
    // the widget.
    const value = raw === "showcase" ? "showcase" : "horizontal";
    await updateShopConfig(session.shop, { productCardStyle: value });
    return { saved: true };
  }

  if (intent === "toggle_rag") {
    const value = formData.get("knowledgeRagEnabled") === "true";
    if (value) {
      // Block opt-in if no embedding provider — flag would be on but
      // retrieval would always return [] and silently fall back to
      // legacy. Better to nudge the merchant to Settings first.
      const cfg = await getShopConfig(session.shop);
      const resolved = resolveShopEmbedding(cfg);
      if (!resolved) {
        return { error: "Configure an embedding provider and API key in Settings before enabling RAG." };
      }
    }
    await updateShopConfig(session.shop, { knowledgeRagEnabled: value });
    return { saved: true };
  }

  if (intent === "save_exclusions") {
    const raw = formData.get("categoryExclusions");
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        await updateShopConfig(session.shop, { categoryExclusions: JSON.stringify(parsed) });
        return { saved: true };
      }
    } catch { /* */ }
    return { error: "Invalid search rules." };
  }

  if (intent === "save_category_groups") {
    const raw = formData.get("categoryGroups");
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { error: "Invalid category groups." };
      const cleaned = parsed
        .map((g) => ({
          name: String(g?.name || "").trim(),
          categories: Array.isArray(g?.categories)
            ? g.categories.map((c) => String(c || "").trim()).filter(Boolean)
            : [],
          triggers: Array.isArray(g?.triggers)
            ? g.triggers.map((t) => String(t || "").trim().toLowerCase()).filter(Boolean)
            : [],
          goesInsideOf: String(g?.goesInsideOf || "").trim(),
        }))
        .filter((g) => g.name && g.categories.length > 0);
      await updateShopConfig(session.shop, { categoryGroups: JSON.stringify(cleaned) });
      return { saved: true };
    } catch { /* */ }
    return { error: "Invalid category groups." };
  }

  if (intent === "save_campaign") {
    const id = String(formData.get("id") || "").trim() || null;
    const name = String(formData.get("name") || "").trim();
    const content = String(formData.get("content") || "").trim();
    const startsAt = String(formData.get("startsAt") || "").trim();
    const endsAt = String(formData.get("endsAt") || "").trim();
    try {
      const saved = await saveCampaign(session.shop, { id, name, content, startsAt, endsAt });
      // Soft validation: flag SKU-shaped tokens that don't resolve to
      // a real product or variant in the synced catalog. Catches typos
      // like "L5OO" before they show up in customer answers. The
      // campaign is saved either way — merchant decides if the warning
      // matters (e.g. a campaign for unreleased SKUs is fine).
      const unknownSkus = await findUnknownSkus(session.shop, content);
      return { saved: true, campaignId: saved.id, unknownSkus };
    } catch (err) {
      return { error: err?.message || "Could not save campaign." };
    }
  }

  if (intent === "delete_campaign") {
    const id = String(formData.get("id") || "").trim();
    if (!id) return { error: "Missing campaign id." };
    await deleteCampaign(session.shop, id);
    return { saved: true };
  }

  if (intent === "save_campaign_cheat_code") {
    const code = String(formData.get("campaignCheatCode") || "").trim().slice(0, 80);
    await updateShopConfig(session.shop, { campaignCheatCode: code });
    return { saved: true };
  }

  // Decision-tree engine actions. The ShopConfig.decisionTreeEnabled
  // toggle is the master switch; individual trees also have their
  // own .enabled flag so a merchant can stage a tree without firing
  // it on customers.
  if (intent === "toggle_decision_tree") {
    const value = formData.get("decisionTreeEnabled") === "true";
    await updateShopConfig(session.shop, { decisionTreeEnabled: value });
    return { saved: true };
  }

  if (intent === "save_decision_tree") {
    const id = String(formData.get("id") || "").trim() || null;
    const name = String(formData.get("name") || "").trim();
    const treeIntent = String(formData.get("treeIntent") || "").trim();
    const triggerCategoryGroup = String(formData.get("triggerCategoryGroup") || "").trim() || null;
    const triggerPhrasesRaw = String(formData.get("triggerPhrases") || "").trim();
    const definitionRaw = String(formData.get("definition") || "").trim();
    const enabled = formData.get("enabled") === "true";
    if (!name) return { error: "Tree name is required." };
    if (!treeIntent) return { error: "Intent slug is required (a-z, 0-9, _, -)." };
    let definition;
    try { definition = JSON.parse(definitionRaw); }
    catch { return { error: "Definition must be valid JSON." }; }
    const v = validateDecisionTree(definition);
    if (!v.ok) return { error: "Tree validation failed: " + v.errors.slice(0, 4).join("; ") };
    const phrases = triggerPhrasesRaw
      ? triggerPhrasesRaw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
      : [];
    try {
      const saved = await saveDecisionTree(session.shop, {
        id,
        name,
        intent: treeIntent,
        triggerPhrases: JSON.stringify(phrases),
        triggerCategoryGroup,
        definition,
        enabled,
      });
      return { saved: true, treeId: saved.id };
    } catch (err) {
      return { error: err?.message || "Could not save tree." };
    }
  }

  if (intent === "delete_decision_tree") {
    const id = String(formData.get("id") || "").trim();
    if (id) await deleteDecisionTree(session.shop, id);
    return { saved: true };
  }

  // One-click installer for Aetrex's orthotic tree. Reads the
  // bundled seed JSON from the repo and upserts it on this shop.
  // Idempotent — running twice updates the same row. The tree is
  // created with enabled=false so the merchant reviews it before
  // it goes live; flipping the master toggle requires a separate
  // explicit action.
  if (intent === "seed_aetrex_orthotic_tree") {
    try {
      const seedPath = path.resolve(process.cwd(), "scripts/seeds/aetrex-orthotic-tree.json");
      const definition = JSON.parse(await readFile(seedPath, "utf8"));
      const v = validateDecisionTree(definition);
      if (!v.ok) return { error: "Bundled seed is invalid: " + v.errors.slice(0, 4).join("; ") };
      const existing = await getDecisionTreeByIntent(session.shop, "orthotic");
      const saved = await saveDecisionTree(session.shop, {
        id: existing?.id,
        name: "Aetrex Orthotic Finder",
        intent: "orthotic",
        triggerPhrases: JSON.stringify([
          "orthotic", "orthotics", "insole", "insoles", "arch support", "custom orthotic",
        ]),
        triggerCategoryGroup: "Orthotics",
        definition,
        enabled: false,
      });
      return { saved: true, seeded: true, treeId: saved.id };
    } catch (err) {
      return { error: "Seed failed: " + (err?.message || "unknown") };
    }
  }

  if (intent === "load_decision_tree") {
    // Returns the full tree definition for the editor. Kept as a
    // separate intent so the loader doesn't ship every tree's full
    // (possibly large) definition on every page render.
    const id = String(formData.get("id") || "").trim();
    if (!id) return { error: "tree id required" };
    const tree = await getDecisionTreeById(session.shop, id);
    if (!tree) return { error: "tree not found" };
    return {
      loadedTree: {
        id: tree.id,
        name: tree.name,
        intent: tree.intent,
        triggerPhrases: tree.triggerPhrases,
        triggerCategoryGroup: tree.triggerCategoryGroup,
        enabled: tree.enabled,
        definition: tree.definition,
      },
    };
  }

  if (intent === "save_synonyms") {
    const raw = formData.get("querySynonyms");
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        await updateShopConfig(session.shop, { querySynonyms: JSON.stringify(parsed) });
        return { saved: true };
      }
    } catch { /* */ }
    return { error: "Invalid synonyms." };
  }

  if (intent === "save_similar_attrs") {
    const raw = formData.get("similarMatchAttributes");
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const clean = parsed
          .map((s) => (typeof s === "string" ? s.trim() : ""))
          .filter(Boolean);
        await updateShopConfig(session.shop, { similarMatchAttributes: JSON.stringify(clean) });
        return { saved: true };
      }
    } catch { /* */ }
    return { error: "Invalid similarity attributes." };
  }

  if (intent === "toggle_fit_predictor") {
    const value = formData.get("fitPredictorEnabled") === "true";
    await updateShopConfig(session.shop, { fitPredictorEnabled: value });
    return { saved: true };
  }

  if (intent === "save_fit_predictor_config") {
    const raw = formData.get("fitPredictorConfig");
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const clean = {
          reviewsWeight: Number.isFinite(parsed.reviewsWeight) ? Math.max(0, Math.min(1, parsed.reviewsWeight)) : 0.4,
          returnsWeight: Number.isFinite(parsed.returnsWeight) ? Math.max(0, Math.min(1, parsed.returnsWeight)) : 0.2,
          historyWeight: Number.isFinite(parsed.historyWeight) ? Math.max(0, Math.min(1, parsed.historyWeight)) : 0.3,
          externalWeight: Number.isFinite(parsed.externalWeight) ? Math.max(0, Math.min(1, parsed.externalWeight)) : 0.1,
          minConfidence: Number.isFinite(parsed.minConfidence) ? Math.max(0, Math.min(100, parsed.minConfidence)) : 50,
          display: parsed.display === "percent" || parsed.display === "bar" || parsed.display === "hide" ? parsed.display : "bar",
          externalUrl: typeof parsed.externalUrl === "string" ? parsed.externalUrl.trim() : "",
          externalAuthHeader: typeof parsed.externalAuthHeader === "string" ? parsed.externalAuthHeader.trim() : "",
        };
        await updateShopConfig(session.shop, { fitPredictorConfig: JSON.stringify(clean) });
        return { saved: true };
      }
    } catch { /* */ }
    return { error: "Invalid fit predictor config." };
  }

  if (intent === "save_collection_links") {
    const raw = formData.get("collectionLinks");
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const clean = parsed
          .map((r) => ({
            category: String(r?.category || "").trim(),
            gender: String(r?.gender || "").trim(),
            url: String(r?.url || "").trim(),
            label: String(r?.label || "").trim(),
          }))
          .filter((r) => r.category && r.url);
        await updateShopConfig(session.shop, { collectionLinks: JSON.stringify(clean) });
        return { saved: true };
      }
    } catch { /* */ }
    return { error: "Invalid collection links." };
  }

  if (intent === "upload") {
    const fileName = formData.get("fileName");
    const fileType = formData.get("fileType");
    const content = formData.get("content");
    const fileSize = parseInt(formData.get("fileSize"), 10);

    if (!content || !fileType) return { error: "File and type are required" };

    const MAX_FILE_BYTES = 10 * 1024 * 1024;
    if (content.length > MAX_FILE_BYTES) {
      return { error: `File too large. Max ${MAX_FILE_BYTES / 1024 / 1024}MB.` };
    }

    const saved = await saveKnowledgeFile(session.shop, { fileName, fileType, fileSize, content });
    await deleteEnrichmentsBySourceFile(saved.id);

    let enrichmentMessage = "";
    let skuWarning = false;
    if (isCsv(fileName)) {
      const result = await upsertEnrichmentsFromCsv(session.shop, saved, content);
      if (result.noSkuColumn) {
        enrichmentMessage = " No SKU column detected — stored as raw context.";
      } else if (result.total > 0) {
        enrichmentMessage = ` Linked ${result.total} SKUs (${result.matched} matched your catalog).`;
        if (result.matched === 0) skuWarning = true;
      }
    }

    // Fire-and-forget: rebuild RAG chunks so retrieval reflects the new
    // file. Skipped silently if the shop has no embedding provider —
    // legacy full-dump path keeps working until they opt in. Don't
    // await, so the upload UX stays snappy.
    (async () => {
      try {
        const config = await getShopConfig(session.shop);
        const resolved = resolveShopEmbedding(config);
        if (!resolved) return;
        const result = await rebuildChunksForFile(prisma, {
          shop: session.shop,
          sourceFileId: saved.id,
          fileType: saved.fileType,
          content: saved.content,
          provider: resolved.provider,
          apiKey: resolved.apiKey,
        });
        console.log(`[knowledge-chunks] rebuilt for shop=${session.shop} file=${saved.id}:`, result);
      } catch (err) {
        console.error(`[knowledge-chunks] background rebuild failed for shop=${session.shop} file=${saved.id}:`, err?.message || err);
      }
    })();

    return { uploaded: true, skuWarning, message: `${fileName} uploaded successfully.${enrichmentMessage}` };
  }

  if (intent === "delete_file") {
    const fileId = formData.get("fileId");
    await deleteEnrichmentsBySourceFile(fileId);
    // Drop chunks before the parent file row — KnowledgeChunk has no
    // FK to KnowledgeFile (sourceFileId is a plain string), so this
    // keeps the orphan-row count at zero without a cascade.
    await prisma.knowledgeChunk.deleteMany({ where: { shop: session.shop, sourceFileId: fileId } });
    await deleteKnowledgeFile(fileId);
    return { deleted: true };
  }

  if (intent === "download_file") {
    const fileId = String(formData.get("fileId") || "");
    if (!fileId) return { error: "fileId required" };
    const file = await getKnowledgeFileForDownload(session.shop, fileId);
    if (!file) return { error: "File not found" };
    return { download: { fileName: file.fileName, content: file.content, fileType: file.fileType } };
  }

  return { error: "unknown intent" };
};

const FILE_TYPES = [
  {
    label: "FAQs & Policies",
    value: "faqs",
    description: "Shipping, returns, warranty, common customer questions.",
    templateName: "faqs-template.txt",
    template: `RETURN POLICY
═══════════════════════════════════════
Wear your Aetrex shoes or orthotics for up to 30 days from the date your
order was received. If they are not the perfect fit, send them back through
the return portal. A $5.95 return fee is deducted from U.S. returns; final
sale items are non-refundable.

Exchanges are processed the same way — return the original, then place a
new order for the replacement.

═══════════════════════════════════════

SHIPPING
═══════════════════════════════════════
Online orders are processed and shipped within 48 hours. U.S. estimated
delivery is typically 3-7 business days from purchase date. Expedited
shipping is available at checkout.

International shipping is available to most countries. Customs and duties
are the customer's responsibility.

═══════════════════════════════════════

WARRANTY
═══════════════════════════════════════
All products carry a 1-year manufacturer warranty against defects in
materials and workmanship. Normal wear and tear is not covered.

═══════════════════════════════════════

ORDER CHANGES
═══════════════════════════════════════
Orders can be modified or cancelled within 1 hour of placement. After that,
they enter our fulfillment queue and cannot be changed.

═══════════════════════════════════════
`,
  },
  {
    label: "Rules & Guidelines",
    value: "rules",
    description: "Things the AI must always/never do — tone, routing rules, banned phrases, escalation paths.",
    templateName: "rules-template.txt",
    template: `TONE & STYLE
═══════════════════════════════════════
ALWAYS:
- Keep replies to 1-2 sentences unless answering a complex question.
- Use the customer's first name sparingly when logged in.
- Match the brand voice (warm, knowledgeable, never pushy).

NEVER:
- Invent product codes, SKUs, or model numbers.
- Claim items are out of stock without checking inventory.
- Promise specific delivery dates beyond what shipping policy states.

═══════════════════════════════════════

ROUTING RULES
═══════════════════════════════════════
Send these topics to the support team (do NOT attempt to resolve in chat):
- Returns, refunds, billing issues
- Damaged or missing items
- Account / login problems
- Order modifications past the 1-hour window

═══════════════════════════════════════

ESCALATION
═══════════════════════════════════════
If a customer is frustrated or asks for a human, share the support email
and let them know expected response time. Do not promise callbacks.

═══════════════════════════════════════
`,
  },
  {
    label: "Brand / About",
    value: "brand",
    description: "Your story, values, voice, and tone.",
    templateName: "brand-template.txt",
    template: `BRAND OVERVIEW
═══════════════════════════════════════
Brand Name: [Your Brand Name]
Founded: [Year]
Headquarters: [City, Country]

In one sentence: [What you make and who you make it for.]

═══════════════════════════════════════

OUR STORY
═══════════════════════════════════════
[2-3 sentences about how the brand started and what makes it different.
This is what the AI uses when customers ask "what's your brand about?" or
"why should I buy from you?"]

═══════════════════════════════════════

VALUES
═══════════════════════════════════════
- [Value 1, e.g. "Sustainability — every product has a take-back program."]
- [Value 2, e.g. "Quality over quantity — small batches, lifetime repairs."]
- [Value 3]

═══════════════════════════════════════

VOICE & TONE
═══════════════════════════════════════
We sound: [warm / premium / playful / technical / etc.]
We avoid: [jargon / hard-sell / hyperbole / etc.]

Example phrasing the AI can mirror:
- "[Sample sentence in your voice.]"
- "[Another sample.]"

═══════════════════════════════════════
`,
  },
  {
    label: "Product Details",
    value: "products",
    description: "Extra product info — materials, care, sizing. Include a SKU column to auto-link.",
    templateName: "product-details-template.csv",
    columns: "sku, material, care_instructions, fit_notes, weight, made_in",
    template: `sku,material,care_instructions,fit_notes,weight,made_in
"SKU-001","100% organic cotton","Machine wash cold","Runs true to size","200g","Portugal"
"SKU-002","80% wool / 20% nylon","Hand wash, lay flat","Size up for relaxed fit","420g","Italy"
`,
  },
  {
    label: "Custom Knowledge",
    value: "custom",
    description: "Anything else the AI should know — promotions, seasonal info, store policies.",
    templateName: "custom-knowledge-template.txt",
    template: `CURRENT PROMOTION
═══════════════════════════════════════
[Promotion name, e.g. "Summer Sale"]
Dates: [Start] – [End]
Mechanic: [e.g. "20% off all sandals with code SUMMER20"]
Eligibility: [Who qualifies, exclusions]

═══════════════════════════════════════

LOYALTY PROGRAM
═══════════════════════════════════════
[Name of program]
- How to join: [signup details]
- Earning: [points-per-dollar or tier rules]
- Redeeming: [what points get you]

═══════════════════════════════════════

STORE LOCATIONS
═══════════════════════════════════════
[City 1] — [Address, hours]
[City 2] — [Address, hours]

═══════════════════════════════════════

SEASONAL NOTES
═══════════════════════════════════════
[Anything time-bound that customers ask about — winter shipping delays,
holiday return-window extensions, restock schedules, etc.]

═══════════════════════════════════════
`,
  },
];

function formatTime(iso) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// Knowledge-corpus size thresholds. The bar fills from 0 to the
// danger threshold (40KB) — beyond that it's pegged at 100% and
// turns red. Picking danger as the "full" point makes the visual
// fill match the color: ~half-full = yellow zone, completely full
// = red zone. Numbers based on observed prompt-bloat behavior:
// under 20KB is comfortable on the legacy full-dump path; 20-40KB
// crowds the system prompt and risks "lost in the middle"; over
// 40KB degrades chat quality unless RAG is on.
const KNOWLEDGE_SIZE_LIMITS = { warn: 20 * 1024, danger: 40 * 1024 };

// Campaign content goes verbatim into the system prompt while a
// campaign is live. Approximate the prompt-time footprint of each
// campaign so the knowledge-size meter reflects the FULL prompt
// budget (knowledge files + active campaign blocks), not just files.
//
// The boilerplate ('## name\nRunning: <date> – <date>\n\n') is roughly
// 120 chars per campaign. The section header above all campaigns is
// roughly 280 chars. Sum name + content + boilerplate per campaign.
const CAMPAIGN_BLOCK_OVERHEAD = 120; // per-campaign formatting bytes
const CAMPAIGN_SECTION_OVERHEAD = 280; // section header bytes (only added when ≥1)
export function calcCampaignBytes(campaigns) {
  if (!Array.isArray(campaigns) || campaigns.length === 0) return 0;
  let bytes = CAMPAIGN_SECTION_OVERHEAD;
  for (const c of campaigns) {
    bytes += CAMPAIGN_BLOCK_OVERHEAD;
    bytes += String(c?.name || "").length;
    bytes += String(c?.content || "").length;
  }
  return bytes;
}

function knowledgeUsageState(totalBytes) {
  if (totalBytes >= KNOWLEDGE_SIZE_LIMITS.danger) {
    return {
      tone: "critical",
      barColor: "#d72c0d",
      label: "Too much — trim files or enable RAG to keep chat quality high.",
    };
  }
  if (totalBytes >= KNOWLEDGE_SIZE_LIMITS.warn) {
    return {
      tone: "warning",
      barColor: "#b98900",
      label: "Getting heavy. Consider trimming or enabling RAG before adding more.",
    };
  }
  return {
    tone: "subdued",
    barColor: "#202223",
    label: "Within the comfortable range for chat-prompt size.",
  };
}

function KnowledgeUsageBar({ files, campaignBytes = 0, campaignCount = 0 }) {
  const fileBytes = files.reduce((sum, f) => sum + (Number(f.fileSize) || 0), 0);
  const totalBytes = fileBytes + campaignBytes;
  const { barColor, label, tone } = knowledgeUsageState(totalBytes);
  const pct = Math.min(100, (totalBytes / KNOWLEDGE_SIZE_LIMITS.danger) * 100);
  const warnPct = (KNOWLEDGE_SIZE_LIMITS.warn / KNOWLEDGE_SIZE_LIMITS.danger) * 100;
  const breakdown = campaignBytes > 0
    ? `${formatSize(fileBytes)} files + ${formatSize(campaignBytes)} from ${campaignCount} ${campaignCount === 1 ? "campaign" : "campaigns"}`
    : null;
  return (
    <BlockStack gap="100">
      <InlineStack align="space-between" blockAlign="center" wrap>
        <Text as="span" variant="bodySm" fontWeight="semibold">
          Prompt context size: {formatSize(totalBytes)} of ~{formatSize(KNOWLEDGE_SIZE_LIMITS.danger)} comfortable budget
        </Text>
        <Text as="span" tone={tone} variant="bodySm">{label}</Text>
      </InlineStack>
      {breakdown && (
        <Text as="span" variant="bodySm" tone="subdued">{breakdown}</Text>
      )}
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Knowledge corpus size relative to chat-prompt budget"
        style={{ position: "relative", width: "100%", height: 8, background: "#e1e3e5", borderRadius: 4, overflow: "hidden" }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: barColor, transition: "width .2s, background .2s" }} />
        {/* Single tick at the warn threshold so merchants can see where yellow kicks in */}
        <div style={{ position: "absolute", left: `${warnPct}%`, top: 0, bottom: 0, width: 1, background: "rgba(0,0,0,0.25)" }} />
      </div>
    </BlockStack>
  );
}

function statusBadge(status) {
  if (status === "running") return <Badge tone="info">Syncing</Badge>;
  if (status === "error") return <Badge tone="critical">Error</Badge>;
  return <Badge tone="success">Idle</Badge>;
}

function KnowledgeFilesCard({ files, ragEnabled, embeddingProvider, campaignBytes = 0, campaignCount = 0 }) {
  const actionData = useActionData();
  const nav = useNavigation();
  const submit = useSubmit();
  const downloadFetcher = useFetcher();
  const ragFetcher = useFetcher();
  const saving = nav.state === "submitting" &&
    (nav.formData?.get("intent") === "upload" || nav.formData?.get("intent") === "delete_file");
  const handleToggleRag = (checked) => {
    const fd = new FormData();
    fd.set("intent", "toggle_rag");
    fd.set("knowledgeRagEnabled", String(checked));
    ragFetcher.submit(fd, { method: "post" });
  };
  const ragHasProvider = Boolean(embeddingProvider);

  const [selectedType, setSelectedType] = useState("faqs");
  const [uploadFile, setUploadFile] = useState(null);
  const [dismissed, setDismissed] = useState(null);

  const currentType = FILE_TYPES.find((t) => t.value === selectedType);

  const triggerBrowserDownload = useCallback((fileName, content) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const lastDownloadKey = useRef(null);
  useEffect(() => {
    const d = downloadFetcher.data?.download;
    if (d && d.fileName && typeof d.content === "string") {
      const key = `${d.fileName}:${d.content.length}`;
      if (lastDownloadKey.current !== key) {
        lastDownloadKey.current = key;
        triggerBrowserDownload(d.fileName, d.content);
      }
    }
  }, [downloadFetcher.data, triggerBrowserDownload]);

  const downloadTemplate = useCallback(() => {
    if (!currentType?.template) return;
    triggerBrowserDownload(currentType.templateName, currentType.template);
  }, [currentType, triggerBrowserDownload]);

  const handleDropAccepted = (droppedFiles) => {
    const file = droppedFiles[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setUploadFile({ name: file.name, size: file.size, content: e.target.result });
    };
    reader.readAsText(file);
  };

  const handleUpload = () => {
    if (!uploadFile) return;
    const fd = new FormData();
    fd.set("intent", "upload");
    fd.set("fileName", uploadFile.name);
    fd.set("fileType", selectedType);
    fd.set("fileSize", uploadFile.size.toString());
    fd.set("content", uploadFile.content);
    submit(fd, { method: "post" });
    setUploadFile(null);
  };

  const handleDelete = (fileId) => {
    const fd = new FormData();
    fd.set("intent", "delete_file");
    fd.set("fileId", fileId);
    submit(fd, { method: "post" });
  };

  const handleDownload = (fileId) => {
    const fd = new FormData();
    fd.set("intent", "download_file");
    fd.set("fileId", fileId);
    downloadFetcher.submit(fd, { method: "post" });
  };

  const isDownloadingId = downloadFetcher.state !== "idle" && downloadFetcher.formData?.get("intent") === "download_file"
    ? String(downloadFetcher.formData.get("fileId") || "")
    : null;

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Knowledge files</Text>
            <Badge>Soft context</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Upload extra context the AI can't get from Shopify — FAQs, brand voice, sizing guides, product details. One file per category; re-uploading replaces the previous. CSVs with a <code>sku</code> column auto-link to matching variants.
          </Text>
        </BlockStack>

        {(files.length > 0 || campaignBytes > 0) && <KnowledgeUsageBar files={files} campaignBytes={campaignBytes} campaignCount={campaignCount} />}

        <Box padding="300" background="bg-surface-secondary" borderRadius="200">
          <BlockStack gap="150">
            <Checkbox
              label="Use RAG retrieval (only inject the most relevant knowledge per chat turn)"
              helpText={
                ragHasProvider
                  ? "Instead of dumping every knowledge file into every chat, the AI receives only the top sections most relevant to the customer's current message. Recommended once your corpus is heavy. Requires running the backfill once after enabling."
                  : "Configure an embedding provider (OpenAI or Voyage) and key in Settings before enabling. Without one, RAG can't embed your knowledge files."
              }
              checked={ragEnabled}
              disabled={!ragHasProvider || ragFetcher.state === "submitting"}
              onChange={handleToggleRag}
            />
            {ragFetcher.data?.error && (
              <Text as="p" tone="critical" variant="bodySm">{ragFetcher.data.error}</Text>
            )}
          </BlockStack>
        </Box>

        {actionData?.uploaded && dismissed !== actionData.message && (
          <Banner title={actionData.message} tone={actionData.skuWarning ? "warning" : "success"} onDismiss={() => setDismissed(actionData.message)} />
        )}
        {actionData?.error && dismissed !== actionData.error && (
          <Banner title={actionData.error} tone="critical" onDismiss={() => setDismissed(actionData.error)} />
        )}

        <Layout>
          <Layout.Section variant="oneHalf">
            <BlockStack gap="300">
              <Select label="Category" options={FILE_TYPES.map((t) => ({ label: t.label, value: t.value }))}
                value={selectedType} onChange={setSelectedType} helpText={currentType?.description} />
              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodySm" fontWeight="semibold">Template: {currentType?.templateName}</Text>
                    <Button size="slim" onClick={downloadTemplate}>Download</Button>
                  </InlineStack>
                  {currentType?.columns && <Text as="p" tone="subdued" variant="bodySm">Columns: <code>{currentType.columns}</code></Text>}
                  {!currentType?.columns && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Sections are separated by <code>═══</code> dividers. Keep this format — when RAG is on, each section becomes a retrievable chunk, so a clean divider = a focused chunk the AI can pull on demand.
                    </Text>
                  )}
                </BlockStack>
              </Box>
              <DropZone
                accept=".csv,.txt,text/plain,text/csv"
                type="file"
                onDropAccepted={handleDropAccepted}
                allowMultiple={false}
                customValidator={(file) => /\.(csv|txt)$/i.test(file.name)}
              >
                {uploadFile ? (
                  <Box padding="400">
                    <BlockStack gap="050">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">{uploadFile.name}</Text>
                      <Text as="p" tone="subdued" variant="bodySm">{formatSize(uploadFile.size)}</Text>
                    </BlockStack>
                  </Box>
                ) : (
                  <DropZone.FileUpload actionHint="Accepts .csv and .txt files" />
                )}
              </DropZone>
              {uploadFile && (
                <InlineStack gap="300">
                  <Button variant="primary" onClick={handleUpload} loading={saving}>Upload as {currentType?.label}</Button>
                  <Button onClick={() => setUploadFile(null)}>Cancel</Button>
                </InlineStack>
              )}
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            {files.length === 0 ? (
              <EmptyState heading="No knowledge files yet" image="">
                <Text as="p" tone="subdued">Upload a CSV or text file to enrich the AI with store-specific context.</Text>
              </EmptyState>
            ) : (
              <BlockStack gap="200">
                {files.map((f) => {
                  const catLabel = FILE_TYPES.find((t) => t.value === f.fileType)?.label || f.fileType;
                  return (
                    <Box key={f.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center" wrap gap="200">
                          <BlockStack gap="050">
                            <Text as="span" variant="bodyMd" fontWeight="semibold" breakWord>{f.fileName}</Text>
                            <InlineStack gap="200" blockAlign="center" wrap>
                              <Badge>{catLabel}</Badge>
                              <Text as="span" tone="subdued" variant="bodySm">{formatSize(f.fileSize)}</Text>
                              <Text as="span" tone="subdued" variant="bodySm">· Updated {new Date(f.updatedAt).toLocaleDateString()}</Text>
                              {f.enrichedSkus > 0 && <Badge tone="success">{`${f.enrichedSkus} SKUs linked`}</Badge>}
                            </InlineStack>
                          </BlockStack>
                          <InlineStack gap="200" blockAlign="center">
                            <Button
                              size="slim"
                              onClick={() => handleDownload(f.id)}
                              loading={isDownloadingId === f.id}
                            >
                              Download
                            </Button>
                            <Button
                              icon={DeleteIcon}
                              tone="critical"
                              variant="plain"
                              onClick={() => handleDelete(f.id)}
                              accessibilityLabel="Delete file"
                            />
                          </InlineStack>
                        </InlineStack>
                      </BlockStack>
                    </Box>
                  );
                })}
              </BlockStack>
            )}
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Card>
  );
}

function DisplayCard({ deduplicateColors, productCardStyle }) {
  const fetcher = useFetcher();
  const styleFetcher = useFetcher();
  const handleDedup = (checked) => {
    const fd = new FormData();
    fd.set("intent", "toggle_dedup");
    fd.set("deduplicateColors", String(checked));
    fetcher.submit(fd, { method: "post" });
  };
  const handleStyleChange = (value) => {
    const fd = new FormData();
    fd.set("intent", "set_card_style");
    fd.set("productCardStyle", value);
    styleFetcher.submit(fd, { method: "post" });
  };
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">Display</Text>

        <BlockStack gap="200">
          <Select
            label="Product card style"
            options={[
              { label: "Compact — image left, info right (up to 3 cards)", value: "horizontal" },
              { label: "Showcase — square image on top, scrollable row (up to 10 cards)", value: "showcase" },
            ]}
            value={productCardStyle || "horizontal"}
            onChange={handleStyleChange}
            disabled={styleFetcher.state === "submitting"}
            helpText="Compact stacks cards vertically and is best when the AI usually returns 1–3 strong matches. Showcase is a horizontal scroll-snap row of larger square cards — good for browse-style queries where customers want to compare more options."
          />
        </BlockStack>

        <Divider />

        <Checkbox label="Deduplicate colors in search results"
          helpText="When enabled, products that differ only by color show a single card instead of one per color variant. Useful when each color is a separate Shopify product."
          checked={deduplicateColors} onChange={handleDedup} />
        <Box background="bg-surface-secondary" padding="300" borderRadius="200">
          <BlockStack gap="150">
            <Text as="p" variant="bodySm" tone="subdued">
              <strong>How dedup works:</strong> the app groups products by everything before the last dash in the title. For this to work, your product titles must follow this format:
            </Text>
            <Text as="p" variant="bodySm">
              <code>Product Name - Color</code>
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Examples: <code>Chase Arch Support Sneaker - Black</code>, <code>Chase Arch Support Sneaker - White</code> → shown as one card. If your titles don't use this pattern, leave this off.
            </Text>
          </BlockStack>
        </Box>
      </BlockStack>
    </Card>
  );
}

function QuerySynonymsCard({ initial }) {
  const fetcher = useFetcher();
  const [entries, setEntries] = useState(initial || []);
  const [term, setTerm] = useState("");
  const [expandsTo, setExpandsTo] = useState("");

  const save = (list) => {
    const fd = new FormData();
    fd.set("intent", "save_synonyms");
    fd.set("querySynonyms", JSON.stringify(list));
    fetcher.submit(fd, { method: "post" });
  };

  const add = () => {
    const t = term.trim().toLowerCase();
    const list = expandsTo.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!t || list.length === 0) return;
    const updated = [...entries.filter((e) => e.term !== t), { term: t, expandsTo: list }];
    setEntries(updated);
    setTerm("");
    setExpandsTo("");
    save(updated);
  };

  const remove = (idx) => {
    const updated = entries.filter((_, i) => i !== idx);
    setEntries(updated);
    save(updated);
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Query synonyms</Text>
            <Badge tone="info">Broadens searches</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            When the customer uses a broad term, also search for related narrower terms — so "shoe" matches sneakers, sandals, boots, and anything else you list. Purely additive; doesn't hide anything.
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Tip: leave this empty and the AI searches exactly what the customer typed. Add entries only when you want a word to cast a wider net.
          </Text>
        </BlockStack>

        {entries.length > 0 && (
          <BlockStack gap="150">
            {entries.map((e, i) => (
              <InlineStack key={i} align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="span" variant="bodyMd" fontWeight="semibold"><code>{e.term}</code></Text>
                  <Text as="span" tone="subdued" variant="bodySm">also searches</Text>
                  {(e.expandsTo || []).map((x, j) => <Tag key={j}>{x}</Tag>)}
                </InlineStack>
                <Button variant="plain" tone="critical" onClick={() => remove(i)}>Remove</Button>
              </InlineStack>
            ))}
          </BlockStack>
        )}

        <Divider />

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Add a synonym</Text>
          <FormLayout>
            <FormLayout.Group>
              <TextField label="When searching for" value={term} onChange={setTerm}
                placeholder="shoe" autoComplete="off"
                helpText="Single word or short phrase." />
              <TextField label="Also search for" value={expandsTo} onChange={setExpandsTo}
                placeholder="sneaker, sandal, boot, slipper" autoComplete="off"
                helpText="Comma-separated related terms." />
            </FormLayout.Group>
            <Button onClick={add} disabled={!term.trim() || !expandsTo.trim()}>Add synonym</Button>
          </FormLayout>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function SimilarMatchAttributesCard({ initial }) {
  const fetcher = useFetcher();
  const [attrs, setAttrs] = useState(initial || []);
  const [input, setInput] = useState("");

  const save = (list) => {
    const fd = new FormData();
    fd.set("intent", "save_similar_attrs");
    fd.set("similarMatchAttributes", JSON.stringify(list));
    fetcher.submit(fd, { method: "post" });
  };

  const add = () => {
    const v = input.trim();
    if (!v) return;
    if (attrs.some((a) => a.toLowerCase() === v.toLowerCase())) {
      setInput("");
      return;
    }
    const updated = [...attrs, v];
    setAttrs(updated);
    setInput("");
    save(updated);
  };

  const remove = (idx) => {
    const updated = attrs.filter((_, i) => i !== idx);
    setAttrs(updated);
    save(updated);
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Similar-product matching</Text>
            <Badge tone="info">Powers "similar to X"</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            When a customer asks for styles "like" or "similar to" a specific product, the AI looks up that product and recommends other products that share the same value for each attribute listed here — plus the same category and gender. The reference product itself is always excluded from the results.
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Enter the exact attribute name you mapped above in <strong>Product attributes</strong> (e.g. <code>footbed</code>, <code>fabric</code>, <code>material</code>, <code>heel_type</code>). Leave empty to disable the similar-products tool.
          </Text>
        </BlockStack>

        {attrs.length > 0 && (
          <InlineStack gap="200" wrap>
            {attrs.map((a, i) => (
              <Tag key={i} onRemove={() => remove(i)}>{a}</Tag>
            ))}
          </InlineStack>
        )}

        <Divider />

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Add an attribute</Text>
          <FormLayout>
            <TextField
              label="Attribute name"
              value={input}
              onChange={setInput}
              placeholder="footbed"
              autoComplete="off"
              helpText="Single attribute key — exactly matching how it appears in Product attributes above."
            />
            <Button onClick={add} disabled={!input.trim()}>Add attribute</Button>
          </FormLayout>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

const GENDER_OPTIONS = [
  { label: "— Any gender —", value: "" },
  { label: "Men", value: "men" },
  { label: "Women", value: "women" },
  { label: "Boy", value: "boy" },
  { label: "Girl", value: "girl" },
  { label: "Kid", value: "kid" },
  { label: "Unisex", value: "unisex" },
];

function CollectionLinksCard({ initial }) {
  const fetcher = useFetcher();
  const [links, setLinks] = useState(initial || []);
  const [category, setCategory] = useState("");
  const [gender, setGender] = useState("");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");

  const save = (list) => {
    const fd = new FormData();
    fd.set("intent", "save_collection_links");
    fd.set("collectionLinks", JSON.stringify(list));
    fetcher.submit(fd, { method: "post" });
  };

  const add = () => {
    const c = category.trim().toLowerCase();
    const g = gender.trim().toLowerCase();
    const u = url.trim();
    const l = label.trim() || category.trim();
    if (!c || !u) return;
    const keyFor = (x) => `${String(x.category || "").toLowerCase()}|${String(x.gender || "").toLowerCase()}`;
    const newEntry = { category: c, gender: g, url: u, label: l };
    const updated = [...links.filter((x) => keyFor(x) !== keyFor(newEntry)), newEntry];
    setLinks(updated);
    setCategory("");
    setGender("");
    setUrl("");
    setLabel("");
    save(updated);
  };

  const remove = (idx) => {
    const updated = links.filter((_, i) => i !== idx);
    setLinks(updated);
    save(updated);
  };

  const genderLabel = (g) => (GENDER_OPTIONS.find((o) => o.value === (g || "").toLowerCase())?.label || "Any gender");

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">"Shop all" collection links</Text>
            <Badge tone="info">Below product cards</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            When the assistant shows product cards and they share a dominant category, a "Shop all <em>&lt;label&gt;</em>" button appears below the cards linking to the collection page configured here.
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Map each (category, gender) pair to its Shopify collection URL. Matching prefers an exact category+gender rule; if none exists, it falls back to a rule set to <em>Any gender</em> for that category.
          </Text>
        </BlockStack>

        {links.length > 0 && (
          <BlockStack gap="150">
            {links.map((r, i) => (
              <InlineStack key={i} align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="span" variant="bodyMd" fontWeight="semibold"><code>{r.category}</code></Text>
                  <Badge tone={r.gender ? "attention" : undefined}>{genderLabel(r.gender)}</Badge>
                  <Text as="span" tone="subdued" variant="bodySm">→</Text>
                  <Text as="span" variant="bodySm"><code>{r.url}</code></Text>
                  <Badge>{`Shop all ${r.label || r.category}`}</Badge>
                </InlineStack>
                <Button variant="plain" tone="critical" onClick={() => remove(i)}>Remove</Button>
              </InlineStack>
            ))}
          </BlockStack>
        )}

        <Divider />

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Add a collection link</Text>
          <FormLayout>
            <FormLayout.Group>
              <TextField label="Category value" value={category} onChange={setCategory}
                placeholder="sneaker" autoComplete="off"
                helpText="Exactly as it appears in the product's category metafield." />
              <Select label="Gender" options={GENDER_OPTIONS} value={gender} onChange={setGender}
                helpText="Leave as 'Any gender' for categories that don't split by gender." />
              <TextField label="Button label" value={label} onChange={setLabel}
                placeholder="Women's Sneakers" autoComplete="off"
                helpText='Shown as "Shop all <label>". Defaults to the category.' />
            </FormLayout.Group>
            <TextField label="Collection URL" value={url} onChange={setUrl}
              placeholder="/collections/womens-sneakers" autoComplete="off"
              helpText="Relative (/collections/womens-sneakers) or absolute." />
            <Button onClick={add} disabled={!category.trim() || !url.trim()}>Add link</Button>
          </FormLayout>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function FitPredictorCard({ enabled, config }) {
  const fetcher = useFetcher();
  const [isOn, setIsOn] = useState(!!enabled);
  const [reviewsW, setReviewsW] = useState(String(config?.reviewsWeight ?? 0.4));
  const [returnsW, setReturnsW] = useState(String(config?.returnsWeight ?? 0.2));
  const [historyW, setHistoryW] = useState(String(config?.historyWeight ?? 0.3));
  const [externalW, setExternalW] = useState(String(config?.externalWeight ?? 0.1));
  const [minConf, setMinConf] = useState(String(config?.minConfidence ?? 50));
  const [display, setDisplay] = useState(config?.display === "percent" ? "percent" : "bar");
  const [externalUrl, setExternalUrl] = useState(config?.externalUrl || "");
  const [externalAuth, setExternalAuth] = useState(config?.externalAuthHeader || "");

  const toggle = (checked) => {
    setIsOn(checked);
    const fd = new FormData();
    fd.set("intent", "toggle_fit_predictor");
    fd.set("fitPredictorEnabled", String(checked));
    fetcher.submit(fd, { method: "post" });
  };

  const saveConfig = () => {
    const num = (v, d) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : d;
    };
    const payload = {
      reviewsWeight: num(reviewsW, 0.4),
      returnsWeight: num(returnsW, 0.2),
      historyWeight: num(historyW, 0.3),
      externalWeight: num(externalW, 0.1),
      minConfidence: num(minConf, 50),
      display,
      externalUrl: externalUrl.trim(),
      externalAuthHeader: externalAuth.trim(),
    };
    const fd = new FormData();
    fd.set("intent", "save_fit_predictor_config");
    fd.set("fitPredictorConfig", JSON.stringify(payload));
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Fit predictor</Text>
            <Badge tone={isOn ? "success" : undefined}>{isOn ? "Enabled" : "Disabled"}</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Gives a visual size recommendation with a confidence score when the customer asks "what size should I get?". Combines review fit data (Yotpo), return sizing reasons (Aftership), the logged-in customer's own order history, and an optional external fit API into one card shown below the product.
          </Text>
        </BlockStack>

        <Checkbox
          label="Enable fit predictor"
          helpText="When off, sizing questions fall back to the existing reviews + returns behavior."
          checked={isOn}
          onChange={toggle}
        />

        {isOn && (
          <>
            <Divider />
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Signal weights (0–1, relative)</Text>
              <FormLayout>
                <FormLayout.Group>
                  <TextField label="Reviews weight" type="number" step="0.05" min="0" max="1"
                    value={reviewsW} onChange={setReviewsW} autoComplete="off"
                    helpText="Yotpo review fit summary." />
                  <TextField label="Returns weight" type="number" step="0.05" min="0" max="1"
                    value={returnsW} onChange={setReturnsW} autoComplete="off"
                    helpText="Aftership sizing return reasons." />
                </FormLayout.Group>
                <FormLayout.Group>
                  <TextField label="History weight" type="number" step="0.05" min="0" max="1"
                    value={historyW} onChange={setHistoryW} autoComplete="off"
                    helpText="Logged-in customer's past order sizes (VIP only)." />
                  <TextField label="External weight" type="number" step="0.05" min="0" max="1"
                    value={externalW} onChange={setExternalW} autoComplete="off"
                    helpText="Optional external fit API (see below)." />
                </FormLayout.Group>
              </FormLayout>
            </BlockStack>

            <Divider />
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Display</Text>
              <FormLayout>
                <FormLayout.Group>
                  <TextField label="Minimum confidence to show (%)" type="number" step="5" min="0" max="100"
                    value={minConf} onChange={setMinConf} autoComplete="off"
                    helpText="Below this, the card is hidden — the AI answers in plain text instead." />
                  <Select
                    label="Visual style"
                    options={[
                      { label: "Progress bar", value: "bar" },
                      { label: "Percent only", value: "percent" },
                      { label: "Hidden (size only)", value: "hide" },
                    ]}
                    value={display}
                    onChange={setDisplay}
                    helpText='How confidence is rendered. "Hidden" shows only the recommended size and reasons — no percentage or bar.'
                  />
                </FormLayout.Group>
              </FormLayout>
            </BlockStack>

            <Divider />
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">External fit API (optional)</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                If you have a foot-scan or fit service, the predictor will POST <code>{`{ shop, productHandle, customerId }`}</code> to this URL and expects JSON <code>{`{ size, confidence?, summary? }`}</code>. Leave blank to skip.
              </Text>
              <FormLayout>
                <TextField
                  label="Endpoint URL"
                  value={externalUrl}
                  onChange={setExternalUrl}
                  placeholder="https://api.example.com/fit"
                  autoComplete="off"
                />
                <TextField
                  label="Auth header (optional)"
                  value={externalAuth}
                  onChange={setExternalAuth}
                  placeholder="Authorization: Bearer xxxx"
                  autoComplete="off"
                  helpText="Format: Header-Name: value"
                />
              </FormLayout>
            </BlockStack>

            <InlineStack align="end">
              <Button variant="primary" onClick={saveConfig} loading={fetcher.state !== "idle" && fetcher.formData?.get("intent") === "save_fit_predictor_config"}>
                Save settings
              </Button>
            </InlineStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

function CategoryGroupsCard({ initial }) {
  const fetcher = useFetcher();
  const [groups, setGroups] = useState(initial || []);
  const [name, setName] = useState("");
  const [categories, setCategories] = useState("");
  const [triggers, setTriggers] = useState("");
  const [goesInsideOf, setGoesInsideOf] = useState("");

  const save = (g) => {
    const fd = new FormData();
    fd.set("intent", "save_category_groups");
    fd.set("categoryGroups", JSON.stringify(g));
    fetcher.submit(fd, { method: "post" });
  };

  const addGroup = () => {
    const n = name.trim();
    const c = categories.split(",").map((s) => s.trim()).filter(Boolean);
    const t = triggers.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const inside = goesInsideOf.trim();
    if (!n || c.length === 0) return;
    const updated = [...groups, { name: n, categories: c, triggers: t, goesInsideOf: inside }];
    setGroups(updated);
    setName("");
    setCategories("");
    setTriggers("");
    setGoesInsideOf("");
    save(updated);
  };

  const removeGroup = (idx) => {
    const updated = groups.filter((_, i) => i !== idx);
    setGroups(updated);
    save(updated);
  };

  const moveGroup = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= groups.length) return;
    const updated = [...groups];
    [updated[idx], updated[target]] = [updated[target], updated[idx]];
    setGroups(updated);
    save(updated);
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Category groups</Text>
            <Badge tone="info">Routes customer intent to the right categories</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Group your catalog categories so the AI understands customer intent. When a customer's message contains one of a group's trigger words, only that group's categories appear as choice buttons.
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Example: a footwear store creates a <strong>Footwear</strong> group with categories <code>Boots, Sneakers, Sandals, Loafers</code> and triggers <code>shoe, shoes, footwear</code>. Now when a customer asks "find me shoes", they see only those four as buttons — not Orthotics, Socks, or Gift Card. Triggers match singular and plural automatically (entering <code>shoe</code> also matches <code>shoes</code>). Multi-match: if a message hits two groups (e.g. "orthotic shoes"), no filter is applied — the AI sees the full catalog and decides.
          </Text>
        </BlockStack>

        {groups.length > 0 && (
          <BlockStack gap="200">
            {groups.map((g, i) => (
              <Box key={i} padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="150">
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="150" blockAlign="center">
                      <Badge>{String(i + 1)}</Badge>
                      <Text as="span" variant="headingSm">{g.name}</Text>
                    </InlineStack>
                    <InlineStack gap="100">
                      <Button size="slim" disabled={i === 0} onClick={() => moveGroup(i, -1)}>↑</Button>
                      <Button size="slim" disabled={i === groups.length - 1} onClick={() => moveGroup(i, 1)}>↓</Button>
                      <Button variant="plain" tone="critical" onClick={() => removeGroup(i)}>Remove</Button>
                    </InlineStack>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Badge tone="success">Categories</Badge>
                    <Text as="span" variant="bodySm"><code>{g.categories.join(", ")}</code></Text>
                  </InlineStack>
                  {g.triggers && g.triggers.length > 0 && (
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Badge tone="info">Triggers</Badge>
                      <Text as="span" variant="bodySm"><code>{g.triggers.join(", ")}</code></Text>
                    </InlineStack>
                  )}
                  {g.goesInsideOf && (
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Badge tone="attention">Goes inside</Badge>
                      <Text as="span" variant="bodySm"><code>{g.goesInsideOf}</code></Text>
                    </InlineStack>
                  )}
                </BlockStack>
              </Box>
            ))}
          </BlockStack>
        )}

        <Divider />

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Add a group</Text>
          <FormLayout>
            <TextField label="Group name" value={name} onChange={setName}
              placeholder="Footwear" autoComplete="off"
              helpText="Internal name. Customers don't see this." />
            <TextField label="Categories in this group" value={categories} onChange={setCategories}
              placeholder="Boots, Sneakers, Sandals, Loafers" autoComplete="off"
              helpText="Comma-separated. Must match category names from your catalog exactly (case-insensitive)." />
            <TextField label="Trigger words" value={triggers} onChange={setTriggers}
              placeholder="shoe, shoes, footwear" autoComplete="off"
              helpText="Comma-separated. When any appears in the customer's latest message (word-boundary, plural-aware), this group's categories take priority." />
            <TextField label="Goes inside (optional)" value={goesInsideOf} onChange={setGoesInsideOf}
              placeholder="Footwear" autoComplete="off"
              helpText="If products in this group are designed to go INSIDE products from another group (e.g. orthotics inside shoes, lenses inside cameras), enter that other group's name here. Lets the AI map phrases like 'something to put inside my shoes' to the correct product type." />
            <Button onClick={addGroup} disabled={!name.trim() || !categories.trim()}>Add group</Button>
          </FormLayout>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function campaignStatus(now, startsAt, endsAt) {
  if (now < startsAt) return { label: "Scheduled", tone: "info" };
  if (now >= startsAt && now <= endsAt) return { label: "Active", tone: "success" };
  return { label: "Expired", tone: undefined };
}

function toLocalInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// New-campaign time defaults: start of today at 12:00 AM, end at
// 3:00 AM. Date is today; merchant changes both date and time via
// the picker. Most sales merchants line up with calendar-day
// boundaries, and a 12 AM / 3 AM default makes it obvious which
// field is which without forcing a re-pick of the time.
function localTodayAt(hour) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}
const DEFAULT_START_VALUE = () => localTodayAt(0);
const DEFAULT_END_VALUE = () => localTodayAt(3);

function CampaignsCard({ initial, template, initialCheatCode, onStatsChange }) {
  const fetcher = useFetcher();
  const cheatFetcher = useFetcher();
  const [campaigns, setCampaigns] = useState(initial || []);
  const [editingId, setEditingId] = useState(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [startsAt, setStartsAt] = useState(DEFAULT_START_VALUE);
  const [endsAt, setEndsAt] = useState(DEFAULT_END_VALUE);
  const [showTemplate, setShowTemplate] = useState(false);
  const [error, setError] = useState("");
  const [unknownSkus, setUnknownSkus] = useState([]);
  const [cheatCode, setCheatCode] = useState(initialCheatCode || "");
  const [cheatSavedNote, setCheatSavedNote] = useState("");

  // Re-sync local state when the loader returns new data after a save/delete.
  useEffect(() => { setCampaigns(initial || []); }, [initial]);
  useEffect(() => { setCheatCode(initialCheatCode || ""); }, [initialCheatCode]);

  // Live-track campaign bytes for the prompt-budget meter. Includes
  // saved campaigns plus the in-progress draft (or the row being
  // edited) so the bar reflects the merchant's typing.
  useEffect(() => {
    if (typeof onStatsChange !== "function") return;
    const draft = name || content
      ? [{ name, content }]
      : [];
    // When editing an existing campaign, swap the saved row out for the
    // edited values to avoid double-counting.
    const merged = editingId
      ? campaigns.map((c) => (c.id === editingId ? { ...c, name, content } : c))
      : campaigns.concat(draft);
    onStatsChange({
      bytes: calcCampaignBytes(merged),
      count: merged.length,
    });
  }, [campaigns, name, content, editingId, onStatsChange]);
  useEffect(() => {
    if (cheatFetcher.data?.saved) {
      setCheatSavedNote("Saved.");
      const t = setTimeout(() => setCheatSavedNote(""), 2500);
      return () => clearTimeout(t);
    }
  }, [cheatFetcher.data]);

  useEffect(() => {
    if (fetcher.data?.error) setError(fetcher.data.error);
    if (fetcher.data?.saved) {
      setError("");
      setUnknownSkus(Array.isArray(fetcher.data.unknownSkus) ? fetcher.data.unknownSkus : []);
      setEditingId(null);
      setName(""); setContent(""); setStartsAt(DEFAULT_START_VALUE()); setEndsAt(DEFAULT_END_VALUE());
    }
  }, [fetcher.data]);

  const reset = () => {
    setEditingId(null);
    setName(""); setContent(""); setStartsAt(""); setEndsAt("");
    setError("");
  };

  const startEdit = (c) => {
    setEditingId(c.id);
    setName(c.name);
    setContent(c.content);
    setStartsAt(toLocalInputValue(c.startsAt));
    setEndsAt(toLocalInputValue(c.endsAt));
    setError("");
  };

  const submit = () => {
    setError("");
    const fd = new FormData();
    fd.set("intent", "save_campaign");
    if (editingId) fd.set("id", editingId);
    fd.set("name", name.trim());
    fd.set("content", content.trim());
    fd.set("startsAt", new Date(startsAt).toISOString());
    fd.set("endsAt", new Date(endsAt).toISOString());
    fetcher.submit(fd, { method: "post" });
  };

  const remove = (id) => {
    if (!window.confirm("Delete this campaign? This cannot be undone.")) return;
    const fd = new FormData();
    fd.set("intent", "delete_campaign");
    fd.set("id", id);
    fetcher.submit(fd, { method: "post" });
  };

  const copyTemplate = () => {
    setContent(template || "");
    setShowTemplate(false);
  };

  const saveCheatCode = () => {
    const fd = new FormData();
    fd.set("intent", "save_campaign_cheat_code");
    fd.set("campaignCheatCode", cheatCode.trim());
    cheatFetcher.submit(fd, { method: "post" });
  };
  const cheatSubmitting = cheatFetcher.state !== "idle";

  const now = new Date();
  const submitting = fetcher.state !== "idle";
  const validForm = name.trim() && content.trim() && startsAt && endsAt && new Date(endsAt) > new Date(startsAt);

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Active promotions</Text>
            <Badge tone="info">Auto-expires by date</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Schedule each campaign with start and end dates and times. Only campaigns currently within their window appear in the chat — expired ones disappear automatically with no manual cleanup.
          </Text>
        </BlockStack>

        {error ? <Banner tone="critical">{error}</Banner> : null}

        {unknownSkus.length > 0 ? (
          <Banner tone="warning" onDismiss={() => setUnknownSkus([])} title={`${unknownSkus.length} SKU${unknownSkus.length === 1 ? "" : "s"} not found in your catalog`}>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm">
                Saved. The campaign content references these SKU-shaped values that don't match any synced product or variant: <strong>{unknownSkus.join(", ")}</strong>. Verify these are correct (a typo like "L5OO" with the letter O instead of zero is a common one) or re-sync your catalog if these are new.
              </Text>
            </BlockStack>
          </Banner>
        ) : null}

        <Box padding="300" background="bg-surface-secondary" borderRadius="200">
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">CS team cheat code</Text>
              <Badge tone="info">Optional</Badge>
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              Set a phrase that, when typed in the chat, returns every currently-active campaign in one reply. Bypasses the AI for determinism — your CS team always sees the exact same dump. Leave blank to disable. Pick something a regular customer would never type by accident.
            </Text>
            <FormLayout>
              <FormLayout.Group>
                <TextField
                  label="Cheat code"
                  value={cheatCode}
                  onChange={setCheatCode}
                  placeholder="seos-show-campaigns"
                  autoComplete="off"
                  helpText="Case-insensitive exact match on the customer's whole message."
                />
                <Box paddingBlockStart="600">
                  <InlineStack gap="200" blockAlign="center">
                    <Button onClick={saveCheatCode} loading={cheatSubmitting} disabled={cheatSubmitting}>Save</Button>
                    {cheatSavedNote ? <Text as="span" tone="success" variant="bodySm">{cheatSavedNote}</Text> : null}
                  </InlineStack>
                </Box>
              </FormLayout.Group>
            </FormLayout>
          </BlockStack>
        </Box>

        {campaigns.length > 0 ? (
          <BlockStack gap="200">
            {campaigns.map((c) => {
              const startDate = new Date(c.startsAt);
              const endDate = new Date(c.endsAt);
              const status = campaignStatus(now, startDate, endDate);
              return (
                <Box key={c.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center" wrap>
                      <InlineStack gap="200" blockAlign="center" wrap>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        <Text as="span" variant="headingSm">{c.name}</Text>
                      </InlineStack>
                      <InlineStack gap="100">
                        <Button size="slim" onClick={() => startEdit(c)} disabled={submitting}>Edit</Button>
                        <Button size="slim" tone="critical" variant="plain" onClick={() => remove(c.id)} disabled={submitting}>Delete</Button>
                      </InlineStack>
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {startDate.toLocaleString()} → {endDate.toLocaleString()}
                    </Text>
                  </BlockStack>
                </Box>
              );
            })}
          </BlockStack>
        ) : (
          <Banner tone="info">No campaigns yet. Add one below — the chat starts answering questions about it the moment its start time arrives.</Banner>
        )}

        <Divider />

        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text as="h3" variant="headingSm">{editingId ? "Edit campaign" : "Add a campaign"}</Text>
            <Button variant="plain" onClick={() => setShowTemplate((v) => !v)}>
              {showTemplate ? "Hide template" : "Show template"}
            </Button>
          </InlineStack>

          {showTemplate ? (
            <Box padding="300" background="bg-surface-secondary" borderRadius="200">
              <BlockStack gap="200">
                <Text as="p" tone="subdued" variant="bodySm">
                  Copy this template into the campaign content field below as a starting structure, then fill in the bracketed placeholders with your actual sale details.
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  <strong>Keep it tight.</strong> Every character of campaign content lands in every chat prompt while the campaign is live — bullet points beat prose, and short codes/dates are better than full sentences. Aim for under ~500 characters (~100 words) per campaign so multiple promos can run together without crowding the AI's working memory. The progress bar at the top of this page tracks the combined size.
                </Text>
                <Box padding="200" background="bg-surface" borderRadius="100">
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{template}</pre>
                </Box>
                <InlineStack>
                  <Button onClick={copyTemplate}>Use this template</Button>
                </InlineStack>
              </BlockStack>
            </Box>
          ) : null}

          <FormLayout>
            <TextField
              label="Campaign name"
              value={name}
              onChange={setName}
              placeholder="Summer Sale 2026"
              autoComplete="off"
              helpText="Internal label only — customers don't see this."
            />
            <FormLayout.Group>
              <TextField
                label="Starts at"
                type="datetime-local"
                value={startsAt}
                onChange={setStartsAt}
                autoComplete="off"
                helpText="Local time of the merchant. The chat starts mentioning this campaign at this moment."
              />
              <TextField
                label="Ends at"
                type="datetime-local"
                value={endsAt}
                onChange={setEndsAt}
                autoComplete="off"
                helpText="The chat stops mentioning this campaign at this moment. Must be after the start."
              />
            </FormLayout.Group>
            <TextField
              label="Campaign content"
              value={content}
              onChange={setContent}
              multiline={10}
              autoComplete="off"
              helpText="Plain text or markdown. The AI quotes from this when customers ask about the sale, codes, or terms. Don't paste internal-only notes."
            />
            <InlineStack gap="200">
              <Button variant="primary" onClick={submit} disabled={!validForm || submitting} loading={submitting}>
                {editingId ? "Save changes" : "Add campaign"}
              </Button>
              {editingId ? <Button onClick={reset} disabled={submitting}>Cancel</Button> : null}
            </InlineStack>
          </FormLayout>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function SemanticSearchCard({ provider, embeddedCount, productsCount }) {
  const fetcher = useFetcher();
  const submittingIntent = fetcher.state !== "idle" ? fetcher.formData?.get("intent") : null;
  const isBackfilling = submittingIntent === "backfill_embeddings";
  const isReembedding = submittingIntent === "clear_and_reembed";
  const result = fetcher.data;
  const displayEmbedded = (() => {
    if (result?.reembedded) {
      return Math.min(productsCount || 0, result.processed || 0);
    }
    if (result?.processed != null) {
      return Math.min(productsCount || 0, embeddedCount + (result.processed || 0));
    }
    return embeddedCount;
  })();

  const startBackfill = () => {
    const fd = new FormData();
    fd.set("intent", "backfill_embeddings");
    fetcher.submit(fd, { method: "post" });
  };

  const startReembed = () => {
    const ok = window.confirm(
      "Re-embed all products? This wipes existing embeddings and re-creates them from current catalog data. Useful after attribute mappings or category metaobjects change. Takes 30-60 seconds for catalogs under 5,000 products."
    );
    if (!ok) return;
    const fd = new FormData();
    fd.set("intent", "clear_and_reembed");
    fetcher.submit(fd, { method: "post" });
  };

  if (!provider) {
    return (
      <Card>
        <BlockStack gap="300">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Semantic search</Text>
            <Badge>Disabled</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Match products by meaning, not keywords. Customers asking for "shoes for standing all day" find arch-support styles even when descriptions don't say "standing". Configure a provider in <strong>Settings → Semantic search</strong> to enable.
          </Text>
        </BlockStack>
      </Card>
    );
  }

  const remaining = Math.max(0, (productsCount || 0) - displayEmbedded);
  const tone = remaining === 0 ? "success" : "info";
  const percent = (productsCount || 0) > 0
    ? Math.min(100, Math.round((displayEmbedded / productsCount) * 100))
    : 0;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h2" variant="headingMd">Semantic search</Text>
          <Badge tone={tone}>{provider === "voyage" ? "Voyage AI" : "OpenAI"}</Badge>
        </InlineStack>
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" tone="subdued" variant="bodySm">
              {displayEmbedded.toLocaleString()} of {(productsCount || 0).toLocaleString()} products embedded
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">{percent}%</Text>
          </InlineStack>
          <ProgressBar progress={percent} tone={remaining === 0 ? "success" : "primary"} size="small" />
        </BlockStack>
        <Text as="p" tone="subdued" variant="bodySm">
          {remaining > 0
            ? `${remaining.toLocaleString()} remaining — click Backfill to embed them. New and updated products are embedded automatically.`
            : "All products are searchable by meaning. New and updated products are embedded automatically."}
        </Text>
        {result?.error && (
          <Banner tone="critical">{result.error}</Banner>
        )}
        {result?.backfilled && !result.error && (
          <Banner tone="success">
            Backfilled {result.processed?.toLocaleString() || 0} product
            {result.processed === 1 ? "" : "s"}.
            {result.failed > 0 ? ` ${result.failed} failed.` : ""}
            {result.remaining > 0 ? ` ${result.remaining.toLocaleString()} remaining — run Backfill again.` : ""}
          </Banner>
        )}
        {result?.reembedded && !result.error && (
          <Banner tone="success">
            Re-embedded {result.processed?.toLocaleString() || 0} product
            {result.processed === 1 ? "" : "s"} with fresh catalog data.
            {result.failed > 0 ? ` ${result.failed} failed.` : ""}
          </Banner>
        )}
        <InlineStack gap="200" wrap>
          <Button
            onClick={startBackfill}
            loading={isBackfilling}
            disabled={(remaining === 0 && !result?.error) || isReembedding}
          >
            {remaining === 0 ? "All products embedded" : `Backfill ${remaining.toLocaleString()} products`}
          </Button>
          <Button
            onClick={startReembed}
            loading={isReembedding}
            disabled={isBackfilling || (productsCount || 0) === 0}
            tone="critical"
            variant="plain"
          >
            Re-embed all (refresh)
          </Button>
        </InlineStack>
        <Text as="p" tone="subdued" variant="bodySm">
          Use <strong>Re-embed all</strong> after attribute mappings change, after the metaobject scope is granted, or after bulk catalog edits — those don't auto-refresh embeddings.
        </Text>
      </BlockStack>
    </Card>
  );
}

function SearchRulesCard({ initial }) {
  const fetcher = useFetcher();
  const [rules, setRules] = useState(initial || []);
  const [whenQuery, setWhenQuery] = useState("");
  const [excludeTerms, setExcludeTerms] = useState("");
  const [overrideTriggers, setOverrideTriggers] = useState("");

  const saveRules = (r) => {
    const fd = new FormData();
    fd.set("intent", "save_exclusions");
    fd.set("categoryExclusions", JSON.stringify(r));
    fetcher.submit(fd, { method: "post" });
  };

  const addRule = () => {
    const w = whenQuery.trim();
    const e = excludeTerms.trim();
    const o = overrideTriggers.trim();
    if (!w || !e) return;
    const rule = { whenQuery: w, excludeTerms: e };
    if (o) rule.overrideTriggers = o;
    const updated = [...rules, rule];
    setRules(updated);
    setWhenQuery("");
    setExcludeTerms("");
    setOverrideTriggers("");
    saveRules(updated);
  };

  const removeRule = (idx) => {
    const updated = rules.filter((_, i) => i !== idx);
    setRules(updated);
    saveRules(updated);
  };

  const moveRule = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= rules.length) return;
    const updated = [...rules];
    [updated[idx], updated[target]] = [updated[target], updated[idx]];
    setRules(updated);
    saveRules(updated);
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Search rules</Text>
            <Badge tone="critical">Hard filter</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            When a trigger keyword appears in the conversation, matching products are hidden from search results before the AI sees them. Rules are evaluated top-to-bottom — first match wins. Skipped when the customer’s search already targets a specific category (a focused category search overrides broad exclusions) or when an override trigger matches.
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Example: trigger <code>foot pain, plantar</code> → exclude <code>sneaker, sandal, boot</code>. The customer sees only relief products like orthotics. Add an <em>override</em> like <code>new footwear, new shoes</code> to let the rule be skipped when the customer explicitly asks for shoes.
          </Text>
        </BlockStack>

        {rules.length > 0 && (
          <BlockStack gap="200">
            {rules.map((r, i) => (
              <Box key={i} padding="300" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="150">
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="150" blockAlign="center">
                      <Badge>{String(i + 1)}</Badge>
                      <Text as="span" variant="bodySm" tone="subdued">Priority</Text>
                    </InlineStack>
                    <InlineStack gap="100">
                      <Button size="slim" disabled={i === 0} onClick={() => moveRule(i, -1)}>↑</Button>
                      <Button size="slim" disabled={i === rules.length - 1} onClick={() => moveRule(i, 1)}>↓</Button>
                      <Button variant="plain" tone="critical" onClick={() => removeRule(i)}>Remove</Button>
                    </InlineStack>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Badge tone="info">When</Badge>
                    <Text as="span" variant="bodySm"><code>{r.whenQuery}</code></Text>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Badge tone="critical">Exclude</Badge>
                    <Text as="span" variant="bodySm"><code>{r.excludeTerms}</code></Text>
                  </InlineStack>
                  {r.overrideTriggers && (
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Badge tone="success">Override</Badge>
                      <Text as="span" variant="bodySm"><code>{r.overrideTriggers}</code></Text>
                    </InlineStack>
                  )}
                </BlockStack>
              </Box>
            ))}
          </BlockStack>
        )}

        <Divider />

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Add a rule</Text>
          <FormLayout>
            <TextField label="When conversation mentions" value={whenQuery} onChange={setWhenQuery}
              placeholder="foot pain, plantar, heel pain" autoComplete="off"
              helpText="Comma-separated triggers. Matched as substrings against the full conversation." />
            <TextField label="Hide products containing" value={excludeTerms} onChange={setExcludeTerms}
              placeholder="sneaker, sandal, boot" autoComplete="off"
              helpText="Comma-separated. Matches product title or product type." />
            <TextField label="Unless customer also says (optional)" value={overrideTriggers} onChange={setOverrideTriggers}
              placeholder="shoe, shoes, footwear, sneaker, sandal, boot" autoComplete="off"
              helpText="Comma-separated. Word-boundary match with automatic singular/plural handling — entering 'shoe' also catches 'shoes', and vice versa. Multi-word phrases like 'new shoes' still work." />
            <Button onClick={addRule} disabled={!whenQuery.trim() || !excludeTerms.trim()}>Add rule</Button>
          </FormLayout>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function AttributeMappingsCard({ mappings }) {
  const fetcher = useFetcher();
  const saving = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "save_mapping";
  const lastError = fetcher.data?.error;
  const lastSaved = fetcher.data?.saved;

  const [attribute, setAttribute] = useState("");
  const [sourceType, setSourceType] = useState("metafield");
  const [target, setTarget] = useState("product");
  const [namespace, setNamespace] = useState("");
  const [key, setKey] = useState("");
  const [prefix, setPrefix] = useState("");

  useEffect(() => {
    if (lastSaved) {
      setAttribute("");
      setNamespace("");
      setKey("");
      setPrefix("");
    }
  }, [lastSaved]);

  const handleSave = () => {
    const fd = new FormData();
    fd.set("intent", "save_mapping");
    fd.set("attribute", attribute);
    fd.set("sourceType", sourceType);
    fd.set("target", target);
    fd.set("namespace", namespace);
    fd.set("key", key);
    fd.set("prefix", prefix);
    fetcher.submit(fd, { method: "post" });
  };

  const handleDelete = (attr) => {
    const fd = new FormData();
    fd.set("intent", "delete_mapping");
    fd.set("attribute", attr);
    fetcher.submit(fd, { method: "post" });
  };

  const canSave =
    attribute.trim().length > 0 &&
    ((sourceType === "metafield" && namespace.trim() && key.trim()) ||
      (sourceType === "tag_prefix" && prefix.trim()));

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Product attributes</Text>
            <Badge tone="warning">Enables filtering</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Map your Shopify metafields or tag prefixes to shared attribute names so the AI can filter results ("show me men's running shoes" → <code>gender: men</code>). Supports product- and variant-level metafields, including Metaobject references.
          </Text>
        </BlockStack>

        {mappings.length > 0 && (
          <>
            <Divider />
            <BlockStack gap="200">
              {mappings.map((m) => (
                <InlineStack key={m.id} align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" variant="bodyMd" fontWeight="semibold">{m.attribute}</Text>
                    <Badge tone={m.target === "variant" ? "attention" : "info"}>
                      {m.target === "variant" ? "Variant" : "Product"}
                    </Badge>
                    {m.sourceType === "metafield" ? (
                      <Tag>{`metafield: ${m.namespace}.${m.key}`}</Tag>
                    ) : (
                      <Tag>{`tag prefix: ${m.prefix}`}</Tag>
                    )}
                  </InlineStack>
                  <Button variant="tertiary" tone="critical" onClick={() => handleDelete(m.attribute)}>
                    Remove
                  </Button>
                </InlineStack>
              ))}
            </BlockStack>
          </>
        )}

        <Divider />

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Add mapping</Text>
          {lastError && <Banner tone="critical"><p>{lastError}</p></Banner>}
          <FormLayout>
            <FormLayout.Group>
              <TextField label="Attribute name" value={attribute} onChange={setAttribute}
                helpText="Shared name the AI will use (e.g. gender, color, category, material, size)." autoComplete="off" />
              <Select label="Source"
                options={[{ label: "Metafield", value: "metafield" }, { label: "Tag prefix", value: "tag_prefix" }]}
                value={sourceType} onChange={setSourceType} />
              <Select label="Target"
                options={[{ label: "Product", value: "product" }, { label: "Variant", value: "variant" }]}
                value={target} onChange={setTarget}
                disabled={sourceType === "tag_prefix"}
                helpText={sourceType === "tag_prefix" ? "Tags live on products only" : undefined} />
            </FormLayout.Group>

            {sourceType === "metafield" ? (
              <FormLayout.Group>
                <TextField label="Namespace" value={namespace} onChange={setNamespace} placeholder="custom" autoComplete="off" />
                <TextField label="Key" value={key} onChange={setKey} placeholder="gender" autoComplete="off" />
              </FormLayout.Group>
            ) : (
              <TextField label="Tag prefix" value={prefix} onChange={setPrefix} placeholder="gender:"
                helpText="Tags starting with this prefix become the attribute value (e.g. tag 'gender:men' → gender=men)." autoComplete="off" />
            )}

            <Button variant="primary" loading={saving} disabled={!canSave} onClick={handleSave}>
              Save mapping
            </Button>
          </FormLayout>
        </BlockStack>

        <Banner tone="info">
          <p>After adding or changing mappings, click <strong>Resync now</strong> above so new attributes get pulled into every product.</p>
        </Banner>
      </BlockStack>
    </Card>
  );
}

function CatalogSyncCard({ data }) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const isStopping = data.status === "stopping" ||
    (fetcher.state !== "idle" && fetcher.formData?.get("intent") === "stop_sync");
  const isRunning = (data.status === "running" || data.status === "stopping" ||
    (fetcher.state !== "idle" && fetcher.formData?.get("intent") === "resync")) && !isStopping;

  useEffect(() => {
    if (data.status !== "running" && data.status !== "stopping") return;
    const t = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(t);
  }, [data.status, revalidator]);

  const handleResync = () => {
    fetcher.submit({ intent: "resync" }, { method: "post" });
  };
  const handleStop = () => {
    fetcher.submit({ intent: "stop_sync" }, { method: "post" });
  };

  const syncedSoFar = data.syncedSoFar || 0;
  const estimate = data.productsCount || 0;
  const pct = estimate > 0 && syncedSoFar > 0 ? Math.min(100, Math.round((syncedSoFar / estimate) * 100)) : null;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">Catalog sync</Text>
            <Text as="p" tone="subdued">
              Indexes your Shopify products, variants, prices, and inventory. The AI searches this database in real time instead of guessing.
            </Text>
          </BlockStack>
          {statusBadge(data.status === "stopping" ? "running" : data.status)}
        </InlineStack>
        <Divider />
        <InlineStack gap="800">
          <Box>
            <Text as="p" tone="subdued" variant="bodySm">Products indexed</Text>
            <Text as="p" variant="headingLg">{data.productsCount}</Text>
          </Box>
          <Box>
            <Text as="p" tone="subdued" variant="bodySm">Last sync</Text>
            <Text as="p" variant="bodyMd">{formatTime(data.lastSyncedAt)}</Text>
          </Box>
          <Box>
            <Text as="p" tone="subdued" variant="bodySm">Next full sync</Text>
            <Text as="p" variant="bodyMd">{formatTime(data.nextScheduledSyncAt)}</Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Nightly reconciliation — product edits sync in real time via webhooks in between.
            </Text>
          </Box>
        </InlineStack>
        {(data.status === "running" || data.status === "stopping") && syncedSoFar > 0 && (
          <BlockStack gap="200">
            <InlineStack align="space-between">
              <Text as="p" variant="bodySm" tone="subdued">
                {isStopping ? "Stopping..." : `${syncedSoFar} products synced${pct !== null ? ` (${pct}%)` : ""}...`}
              </Text>
            </InlineStack>
            {pct !== null && (
              <div style={{ height: "6px", borderRadius: "3px", background: "#e4e5e7", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, borderRadius: "3px", background: "#2D6B4F", transition: "width 0.5s ease" }} />
              </div>
            )}
          </BlockStack>
        )}
        {data.lastError && (
          <Banner tone="critical" title="Last sync failed"><p>{data.lastError}</p></Banner>
        )}
        <InlineStack gap="200">
          {data.status !== "running" && data.status !== "stopping" && (
            <Button variant="primary" loading={isRunning} onClick={handleResync}>
              Resync now
            </Button>
          )}
          {(data.status === "running" || data.status === "stopping") && (
            <Button variant="plain" tone="critical" loading={isStopping} onClick={handleStop}>
              {isStopping ? "Stopping..." : "Stop sync"}
            </Button>
          )}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function PriorityExplainer() {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">How the AI uses these rules</Text>
        <Text as="p" tone="subdued">
          Everything on this page controls how the AI answers customer questions. Rules are applied in this order — higher = stronger. Lower sections add context; higher sections override it.
        </Text>
        <BlockStack gap="150">
          <InlineStack gap="200" blockAlign="center">
            <Badge tone="critical">1</Badge>
            <Text as="p"><strong>Search Rules</strong> — hard filters applied at the database level. The AI cannot override these.</Text>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            <Badge tone="warning">2</Badge>
            <Text as="p"><strong>Product Attributes</strong> — what the AI can filter by (gender, color, category…).</Text>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            <Badge tone="info">3</Badge>
            <Text as="p"><strong>Query Synonyms</strong> — broaden searches so "shoe" also finds "sneaker, sandal…".</Text>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center">
            <Badge>4</Badge>
            <Text as="p"><strong>Knowledge Files</strong> — soft context (FAQs, brand voice, product details).</Text>
          </InlineStack>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function SectionHeading({ eyebrow, title, description }) {
  return (
    <BlockStack gap="100">
      {eyebrow && (
        <Text as="p" variant="bodySm" tone="subdued" fontWeight="semibold">
          {eyebrow.toUpperCase()}
        </Text>
      )}
      <Text as="h2" variant="headingLg">{title}</Text>
      {description && <Text as="p" tone="subdued">{description}</Text>}
    </BlockStack>
  );
}

function DecisionTreesCard({ enabled, trees }) {
  const fetcher = useFetcher();
  const loadFetcher = useFetcher();
  const [editing, setEditing] = useState(null);  // { id?, name, intent, ... }
  const [showCreate, setShowCreate] = useState(false);

  // When the load fetcher returns, hydrate the editor with the full
  // tree (definition included). Kept out of the loader to avoid
  // shipping every tree's full JSON on every page render.
  useEffect(() => {
    const t = loadFetcher.data?.loadedTree;
    if (t) {
      let triggerPhrasesText = "";
      try {
        const arr = JSON.parse(t.triggerPhrases || "[]");
        triggerPhrasesText = Array.isArray(arr) ? arr.join(", ") : "";
      } catch { triggerPhrasesText = String(t.triggerPhrases || ""); }
      setEditing({
        id: t.id,
        name: t.name,
        intent: t.intent,
        triggerPhrases: triggerPhrasesText,
        triggerCategoryGroup: t.triggerCategoryGroup || "",
        enabled: Boolean(t.enabled),
        definition: JSON.stringify(t.definition || {}, null, 2),
      });
      setShowCreate(false);
    }
  }, [loadFetcher.data]);

  const seedAetrex = () => {
    const fd = new FormData();
    fd.set("intent", "seed_aetrex_orthotic_tree");
    fetcher.submit(fd, { method: "post" });
  };

  const toggleMaster = (next) => {
    const fd = new FormData();
    fd.set("intent", "toggle_decision_tree");
    fd.set("decisionTreeEnabled", next ? "true" : "false");
    fetcher.submit(fd, { method: "post" });
  };

  const toggleTree = (tree, next) => {
    // Reuse save_decision_tree to flip just the enabled flag.
    const fd = new FormData();
    fd.set("intent", "load_decision_tree");
    fd.set("id", tree.id);
    loadFetcher.submit(fd, { method: "post" });
    // Pending: once load returns, immediately submit with the new
    // enabled flag. To keep this simple-but-honest, ask the merchant
    // to use the editor for now if they want to flip enabled.
    // Quick path: send a thin save with just the enabled change
    // alongside the existing fields would require refetching the
    // definition first — done via load + a second submit.
    // Implementation note: keeping a single round trip here would
    // be cleaner. For v1, we open the editor with the loaded tree
    // and let the merchant flip the checkbox + Save.
  };

  const startNew = () => {
    setEditing({
      id: null,
      name: "",
      intent: "",
      triggerPhrases: "",
      triggerCategoryGroup: "",
      enabled: false,
      // Minimal valid recommender shape. Only resolver.masterIndex
      // is read by the runtime; the nodes array is preserved for
      // back-compat with rows authored under the previous
      // funnel-based design and for the schema validator (which
      // still requires a rootNodeId pointing at a node — easy to
      // satisfy with a single resolve node).
      definition: JSON.stringify({
        rootNodeId: "q_resolve",
        nodes: [{ id: "q_resolve", type: "resolve" }],
        resolver: {
          defaults: {},
          masterIndex: [
            { masterSku: "EXAMPLE-1", title: "Example product", gender: "Unisex", useCase: "example" },
          ],
        },
      }, null, 2),
    });
    setShowCreate(true);
  };

  const onChange = (field) => (val) => {
    setEditing((prev) => ({ ...prev, [field]: typeof val === "string" ? val : val.target.value }));
  };

  const saveEditor = () => {
    if (!editing) return;
    const fd = new FormData();
    fd.set("intent", "save_decision_tree");
    if (editing.id) fd.set("id", editing.id);
    fd.set("name", editing.name);
    fd.set("treeIntent", editing.intent);
    fd.set("triggerPhrases", editing.triggerPhrases);
    fd.set("triggerCategoryGroup", editing.triggerCategoryGroup);
    fd.set("definition", editing.definition);
    fd.set("enabled", editing.enabled ? "true" : "false");
    fetcher.submit(fd, { method: "post" });
  };

  const deleteEditing = () => {
    if (!editing?.id) { setEditing(null); return; }
    if (!confirm("Delete this decision tree? This cannot be undone.")) return;
    const fd = new FormData();
    fd.set("intent", "delete_decision_tree");
    fd.set("id", editing.id);
    fetcher.submit(fd, { method: "post" });
    setEditing(null);
  };

  // Close editor after successful save (fetcher data has saved=true
  // and includes treeId — only after a save_decision_tree action).
  useEffect(() => {
    if (fetcher.data?.saved && fetcher.data?.treeId && editing) {
      setEditing(null);
      setShowCreate(false);
    }
  }, [fetcher.data]);

  const masterToggleSubmitting =
    fetcher.state === "submitting" &&
    fetcher.formData?.get?.("intent") === "toggle_decision_tree";

  return (
    <Card>
      <BlockStack gap="500">
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingMd">Smart Recommenders</Text>
            <Checkbox
              label={enabled ? "Recommenders ON" : "Recommenders OFF"}
              checked={enabled}
              disabled={masterToggleSubmitting}
              onChange={(next) => toggleMaster(next)}
            />
          </InlineStack>
          <Text as="p" tone="subdued">
            Master switch. When ON, every enabled recommender below is
            registered as a tool the AI can call when it judges the
            customer needs a structured pick. The AI is always in
            charge — recommenders never hijack a conversation. Same
            attributes in always yield the same SKU out (no
            hallucinated products). When OFF (default), no
            recommender tools are exposed and the chat is unchanged.
          </Text>
        </BlockStack>

        {fetcher.data?.error && (
          <Banner tone="critical">{fetcher.data.error}</Banner>
        )}
        {fetcher.data?.seeded && (
          <Banner tone="success">Aetrex Orthotic Finder seeded. Review it below, then enable.</Banner>
        )}

        <Divider />

        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h4" variant="headingSm">Your recommenders</Text>
            <InlineStack gap="200">
              <Button onClick={startNew}>+ New recommender</Button>
              <Button onClick={seedAetrex} variant="primary">
                Seed Aetrex Orthotic Finder
              </Button>
            </InlineStack>
          </InlineStack>

          {(!trees || trees.length === 0) && (
            <Text as="p" tone="subdued">
              No recommenders yet. Click "Seed Aetrex Orthotic Finder" to install
              the bundled lookup table that maps clinical attributes to one of
              Aetrex's 183 orthotic SKUs, or build your own (mattress, pillow,
              supplement — any vertical with a typed attribute → SKU mapping).
            </Text>
          )}

          {trees && trees.length > 0 && (
            <DataTable
              columnContentTypes={["text", "text", "numeric", "text"]}
              headings={["Name", "Intent", "Calls", ""]}
              rows={trees.map((t) => [
                <Text key={`n-${t.id}`} as="span" fontWeight="semibold">{t.name}</Text>,
                <Text key={`i-${t.id}`} as="span">{t.intent}</Text>,
                t.completedCount,
                <InlineStack key={`a-${t.id}`} gap="200">
                  <Badge tone={t.enabled ? "success" : undefined}>
                    {t.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <Button size="slim" onClick={() => {
                    const fd = new FormData();
                    fd.set("intent", "load_decision_tree");
                    fd.set("id", t.id);
                    loadFetcher.submit(fd, { method: "post" });
                  }}>Edit</Button>
                </InlineStack>,
              ])}
            />
          )}
        </BlockStack>

        {editing && (
          <>
            <Divider />
            <BlockStack gap="300">
              <Text as="h4" variant="headingSm">
                {editing.id ? "Edit recommender" : "New recommender"}
              </Text>
              <FormLayout>
                <FormLayout.Group>
                  <TextField
                    label="Name"
                    helpText="Shown in the admin and in the AI's tool description (e.g. Aetrex Orthotic Finder)."
                    value={editing.name}
                    onChange={onChange("name")}
                    autoComplete="off"
                  />
                  <TextField
                    label="Intent slug"
                    helpText="a-z, 0-9, _, - — becomes the tool name (recommend_<intent>) the AI can call. e.g. orthotic, mattress, supplement."
                    value={editing.intent}
                    onChange={onChange("intent")}
                    autoComplete="off"
                  />
                </FormLayout.Group>
                <Checkbox
                  label="Recommender enabled"
                  checked={Boolean(editing.enabled)}
                  onChange={(v) => setEditing((p) => ({ ...p, enabled: v }))}
                />
                <TextField
                  label="Lookup table (JSON)"
                  value={editing.definition}
                  onChange={onChange("definition")}
                  multiline={20}
                  monospaced
                  autoComplete="off"
                  helpText="The resolver.masterIndex array drives the recommendation: each entry maps an attribute set (gender, useCase, condition, etc.) to a master SKU. Validated server-side; bad JSON is rejected. The Aetrex seed is the canonical example."
                />
              </FormLayout>
              <InlineStack gap="200">
                <Button onClick={saveEditor} variant="primary"
                  loading={fetcher.state === "submitting" && fetcher.formData?.get?.("intent") === "save_decision_tree"}
                >
                  Save
                </Button>
                <Button onClick={() => setEditing(null)}>Cancel</Button>
                {editing.id && (
                  <Button onClick={deleteEditing} tone="critical" variant="plain">
                    Delete
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

export default function RulesKnowledge() {
  const data = useLoaderData();
  // Live-tracked campaign bytes — CampaignsCard reports its current
  // bytes via a callback so KnowledgeUsageBar can include them in
  // the prompt-budget meter as the merchant edits campaign text.
  const [campaignStats, setCampaignStats] = useState(() => ({
    bytes: calcCampaignBytes(data.campaigns),
    count: Array.isArray(data.campaigns) ? data.campaigns.length : 0,
  }));

  return (
    <Page>
      <TitleBar title="Catalog" />
      <BrandHeader title="Catalog" />
      <BlockStack gap="800">
        <BlockStack gap="400">
          <SectionHeading
            title="Product data from Shopify"
            description="Keep the AI's product index in sync with your Shopify catalog. Webhooks apply incremental changes automatically within seconds, and large bulk edits trigger an automatic full re-sync. Manual re-sync is only needed if something looks out of date."
          />
          <CatalogSyncCard data={data} />
        </BlockStack>

        <BlockStack gap="400">
          <SectionHeading
            title="Match products by meaning, not just keywords"
            description="Embed your catalog so customers asking for 'shoes for standing all day' find arch-support styles even when the description doesn't say 'standing'. Configure the provider + API key in Settings; manage the index here."
          />
          <SemanticSearchCard
            provider={data.embeddingProvider}
            embeddedCount={data.embeddedCount}
            productsCount={data.productsCount}
          />
        </BlockStack>

        <BlockStack gap="400">
          <SectionHeading
            title="Tell the AI which metafields to filter by"
            description="Map gender, color, size, and other attributes to the metafields or tags they live on in your products."
          />
          <AttributeMappingsCard mappings={data.mappings} />
        </BlockStack>

        <BlockStack gap="400">
          <SectionHeading
            title="How product types group together"
            description="Group your product types (Sneakers + Boots + Sandals = 'Footwear', for example). The AI uses these groups to scope searches and route customer intent."
          />
          <PlanGate
            plan={data.plan}
            feature="searchRules"
            summary="Category groups let you scope the AI's searches to logically-related product types."
          >
            <CategoryGroupsCard initial={data.categoryGroups} />
          </PlanGate>
        </BlockStack>
      </BlockStack>
    </Page>
  );
}
