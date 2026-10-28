import { useEffect, useRef, useState } from "react";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Banner,
  Icon,
  TextField,
  Select,
  Tag,
  Checkbox,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
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
import { fetchMetafieldDefinitions } from "../lib/metafield-definitions.server";
import { buildMetafieldChoices } from "../lib/metafield-picker";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";
import prisma from "../db.server";
import { computeCatalogCoverage, COVERAGE_SOURCE_LABELS } from "../lib/catalog-coverage.js";
import { extractMerchantConditionTags } from "../lib/condition-tags";
import { backfillShopEmbeddings, resolveShopEmbedding } from "../lib/embeddings.server";
import BrandHeader from "../components/BrandHeader";
import { SETTINGS_CSS, Row, Group, SectionHead } from "../components/SettingsUI";
import { nextScheduledSyncAt } from "../lib/catalog-sync-scheduler.server";
import { similarityOptions } from "../lib/similar-attributes.js";
import { getSpecSheet, readSpecUpload, saveSpecSheet, deleteSpecSheet, SPEC_FILE_MAX_BYTES } from "../lib/product-specs.server";
import { shopifySpecsCsv, cleanSheetCsv, specsReportCsv } from "../lib/product-specs.js";
import { loadLeanCatalog, reloadLeanCatalog } from "../lib/lean/catalog.server";
import { styleName } from "../lib/lean/catalog.js";

// The spec sheet as the Catalog page shows it: the file, how far it
// reaches, what shoppers can now ask for, and what needs a look.
async function specsSummary(shop, catalog = null) {
  const sheet = await getSpecSheet(shop);
  const cat = catalog || await loadLeanCatalog(shop).catch(() => null);
  const finds = cat?.vocab?.specs || {};
  if (!sheet) return { sheet: null, finds };
  const r = sheet.report || {};
  const m = cat?.specReport || null;
  const styles = (list) => [...new Set((list || []).map((x) => styleName(x.title).replace(/\s+(arch support|orthotic).*$/i, "")).filter(Boolean))];
  return {
    sheet: {
      fileName: sheet.fileName,
      updatedAt: sheet.updatedAt ? new Date(sheet.updatedAt).toISOString() : null,
      codes: r.codes || 0,
      tabsUsed: (r.tabs || []).filter((t) => t.rows > 0).length,
      tabsSkipped: (r.tabs || []).filter((t) => t.skipped).map((t) => `${t.tab} (${t.skipped})`),
      duplicates: (r.duplicates || []).length,
      odd: (r.odd || []).length,
    },
    match: m ? {
      products: m.products, byCode: m.byCode, byStyle: m.byStyle,
      missing: m.missing.length, missingStyles: styles(m.missing).slice(0, 6), missingStyleCount: styles(m.missing).length,
      nameMismatch: m.nameMismatch.length, left: m.left.length,
    } : null,
    finds,
  };
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
  const { admin, session } = await authenticate.admin(request);
  const [state, count, mappings, config, metafieldDefs] = await Promise.all([
    getCatalogSyncState(session.shop),
    getProductCount(session.shop),
    getAttributeMappings(session.shop),
    getShopConfig(session.shop),
    fetchMetafieldDefinitions(admin),
  ]);
  const metafieldChoices = buildMetafieldChoices({ definitions: metafieldDefs.definitions, mappings });

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

  // Data coverage: which fields the assistant can actually filter on, per
  // product, and where each value comes from (mapping / auto-detected
  // metafield / title / tags). Surfaces gaps before a shopper hits them.
  let coverage = null;
  try {
    const coverageProducts = await prisma.product.findMany({
      where: { shop: session.shop },
      select: {
        title: true, status: true, productType: true, tags: true, attributesJson: true,
        variants: { select: { attributesJson: true, optionsJson: true } },
      },
      take: 5000,
    });
    coverage = computeCatalogCoverage({
      products: coverageProducts,
      mappings,
      conditionTagsOf: extractMerchantConditionTags,
    });
  } catch (err) {
    console.error("[catalog-coverage] failed:", err?.message || err);
  }

  // Attribute names present on synced products — offered as tick boxes for
  // "Show me something similar".
  let attributeKeys = [];
  try {
    attributeKeys = await prisma.$queryRawUnsafe(
      `SELECT e.k AS key, COUNT(*)::int AS n, COUNT(DISTINCT e.v)::int AS distinct_n,
              AVG(length(e.v))::float AS avg_len,
              AVG(CASE WHEN e.v ~ '^[0-9.,\\s/%$-]+$' THEN 1 ELSE 0 END)::float AS numeric_share
         FROM "Product" p,
              jsonb_each_text(CASE WHEN jsonb_typeof(p."attributesJson") = 'object' THEN p."attributesJson" ELSE '{}'::jsonb END) AS e(k, v)
        WHERE p.shop = $1 AND e.v <> ''
        GROUP BY e.k ORDER BY n DESC LIMIT 80`,
      session.shop,
    );
  } catch (err) {
    console.error("[catalog] attribute keys failed:", err?.message || err);
  }

  let specs = null;
  try {
    specs = await specsSummary(session.shop);
  } catch (err) {
    console.error("[catalog] specs summary failed:", err?.message || err);
  }

  return {
    shop: session.shop,
    attributeKeys,
    coverage,
    specs,
    specFileMaxBytes: SPEC_FILE_MAX_BYTES,
    status: state.status,
    lastSyncedAt: state.lastSyncedAt,
    nextScheduledSyncAt: nextScheduledSyncAt().toISOString(),
    lastError: state.lastError,
    productsCount: count,
    syncedSoFar: state.syncedSoFar || 0,
    mappings,
    metafieldChoices,
    metafieldError: metafieldDefs.error,
    embeddingProvider,
    embeddedCount,
    similarMatchAttributes: safeParse(config.similarMatchAttributes, []),
    productCardStyle: config.productCardStyle === "showcase" ? "showcase" : "horizontal",
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

  // "Add all recommended": several fields, one catalog update.
  if (intent === "save_mappings_bulk") {
    let items = [];
    try { items = JSON.parse(String(formData.get("items") || "[]")); } catch { /* */ }
    items = (Array.isArray(items) ? items : []).filter((i) => i?.attribute && i?.namespace && i?.key).slice(0, 60);
    if (items.length === 0) return { error: "Nothing to add." };
    for (const i of items) {
      await upsertAttributeMapping(session.shop, {
        attribute: String(i.attribute).trim().toLowerCase(),
        sourceType: "metafield",
        target: i.target === "variant" ? "variant" : "product",
        namespace: String(i.namespace).trim(),
        key: String(i.key).trim(),
        prefix: null,
      });
    }
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "Product" SET embedding = NULL, "embeddingUpdatedAt" = NULL WHERE shop = $1`,
        session.shop,
      );
    } catch { /* no embedding column */ }
    syncCatalogAsync(admin, session.shop);
    return { saved: true, embeddingsStale: true, syncStarted: true, savedAttribute: `${items.length} fields` };
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
    // Pull the new attribute into every product right away — no separate
    // "Resync" step for the merchant to remember.
    if (formData.get("autoSync") === "1") {
      syncCatalogAsync(admin, session.shop);
      return { saved: true, embeddingsStale: true, syncStarted: true, savedAttribute: attribute };
    }
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
    if (formData.get("autoSync") === "1") {
      syncCatalogAsync(admin, session.shop);
      return { deleted: true, embeddingsStale: true, syncStarted: true };
    }
    return { deleted: true, embeddingsStale: true };
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

  // Product specs: upload (or replace), remove, and the files to download.
  if (intent === "upload_specs") {
    const fileName = String(formData.get("fileName") || "").slice(0, 200);
    const sheet = readSpecUpload({ fileName, base64: String(formData.get("data") || "") });
    if (sheet.error) return { specsError: sheet.error };
    await saveSpecSheet(session.shop, { fileName, rows: sheet.rows, report: sheet.report });
    const catalog = await reloadLeanCatalog(session.shop);
    const summary = await specsSummary(session.shop, catalog);
    return { specsSaved: true, specsMatched: summary.match ? summary.match.byCode + summary.match.byStyle : 0, specsProducts: summary.match?.products || 0 };
  }

  if (intent === "remove_specs") {
    await deleteSpecSheet(session.shop);
    await reloadLeanCatalog(session.shop);
    return { specsRemoved: true };
  }

  if (intent === "download_specs") {
    const kind = String(formData.get("kind") || "");
    const sheet = await getSpecSheet(session.shop);
    if (!sheet) return { specsError: "Upload a spec sheet first." };
    const base = String(sheet.fileName || "specs").replace(/\.[a-z0-9]+$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 60) || "specs";
    if (kind === "clean") return { download: { fileName: `${base}-cleaned.csv`, content: `\uFEFF${cleanSheetCsv(sheet.rows)}` } };
    const catalog = await loadLeanCatalog(session.shop);
    if (kind === "report") {
      return { download: { fileName: `${base}-to-check.csv`, content: `\uFEFF${specsReportCsv({ sheet: sheet.report, match: catalog.specReport || {} })}` } };
    }
    if (kind === "shopify") {
      const products = [...catalog.products].sort((a, b) => a.handle.localeCompare(b.handle));
      const byHandle = new Map(products.map((p) => [p.handle, { specs: p.specs || {} }]));
      // No byte-order mark: Shopify reads the first column's name as is.
      return { download: { fileName: `${base}-shopify-import.csv`, content: shopifySpecsCsv(products, byHandle) } };
    }
    return { specsError: "Unknown download." };
  }

  return { error: "unknown intent" };
};

// Same look as Settings (compact cards of rows, title and help on the left,
// the action on the right), plus a few pieces of this page's own.
const CATALOG_CSS = `
  .ct .set-row__title { overflow-wrap: anywhere; }
  .ct-pad { padding: 13px 16px 0; display: grid; gap: 8px; }
  .ct-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; padding: 14px 16px 12px; }
  .ct-search { flex: 1 1 260px; min-width: 0; }
  .ct-sub { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; padding: 12px 16px 0; border-top: 1px solid rgba(30,27,51,0.07); }
  .ct-sub__label { font-size: 11.5px; line-height: 16px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: #616161; }
  .ct-sub__help { font-size: 12px; line-height: 16px; color: #8a8a8a; }
  .ct-sub + .set-row { padding-top: 8px; }
  .ct-more { padding: 10px 16px 12px; border-top: 1px solid rgba(30,27,51,0.07); }
  .ct-quiet { padding: 0 16px 12px; font-size: 12px; line-height: 17px; color: #8a8a8a; }
  .ct-empty { padding: 4px 16px 14px; font-size: 13px; color: #616161; }
  .ct-bar { height: 6px; border-radius: 999px; background: rgba(26,46,38,0.08); overflow: hidden; }
  .ct-bar > span { display: block; height: 100%; border-radius: inherit; background: #2D6B4F; transition: width .5s ease; }
  .ct-bar--partial > span { background: #b98900; }
  .ct-bar--missing > span { background: #c5280c; }
  .ct-bar--info > span { background: #a8a8a8; }
  .ct-progress { display: grid; gap: 6px; }
  .ct-progress__text { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; color: #616161; font-variant-numeric: tabular-nums; }
  .ct-cov { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1.1fr) minmax(0, 1.35fr) 88px; align-items: center; gap: 6px 20px; padding: 10px 16px; }
  .ct-cov + .ct-cov { border-top: 1px solid rgba(30,27,51,0.06); }
  .ct-cov--head { padding-top: 7px; padding-bottom: 7px; border-top: 1px solid rgba(30,27,51,0.07); font-size: 11.5px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: #8a8a8a; }
  .ct-cov__name { font-size: 13.5px; line-height: 20px; font-weight: 600; color: #1a1a1a; }
  .ct-cov__use { font-size: 12px; line-height: 17px; color: #616161; }
  .ct-cov__num { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-size: 12.5px; color: #303030; font-variant-numeric: tabular-nums; }
  .ct-cov__na, .ct-cov__src { font-size: 12px; line-height: 17px; color: #616161; }
  .ct-cov__na { margin-top: 4px; }
  .ct-cov__status { justify-self: end; }
  .ct-two { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  .ct-ticks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 16px; }
  .ct-note { padding: 10px 12px; border-radius: 10px; background: rgba(26,46,38,0.035); font-size: 12.5px; line-height: 18px; color: #616161; }
  .ct-note strong, .ct-note code { color: #1a1a1a; }
  .ct-note code { font-size: 12px; }
  .ct-help { font-size: 12px; line-height: 17px; color: #616161; }
  .ct-spec-cov { padding-bottom: 0; }
  .ct-finds { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .ct-find { display: grid; align-content: start; gap: 1px; padding: 10px 12px; border-radius: 10px; background: rgba(26,46,38,0.035); }
  .ct-find__n { font-size: 18px; line-height: 24px; font-weight: 650; color: #1a1a1a; font-variant-numeric: tabular-nums; }
  .ct-find__label { font-size: 12.5px; line-height: 17px; font-weight: 600; color: #303030; }
  .ct-find__hint { font-size: 11.5px; line-height: 15px; color: #8a8a8a; }
  .ct-list { margin: 2px 0 0; padding-left: 16px; display: grid; gap: 2px; }
  @media (prefers-reduced-motion: reduce) { .ct-bar > span { transition: none; } }
  @media (max-width: 760px) {
    .ct-two { grid-template-columns: minmax(0, 1fr); }
    .ct-cov { grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; }
    .ct-cov--head { display: none; }
    .ct-cov__status { grid-row: 1; grid-column: 2; }
    .ct-cov__bar, .ct-cov__src { grid-column: 1 / -1; }
    .ct-search { flex-basis: 100%; }
    .ct-ticks { grid-template-columns: minmax(0, 1fr); }
    .ct-finds { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
`;

// Dates read the browser's clock and time zone, so they're shown once the
// page runs in the browser (the server's render then matches the browser's).
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
const timeLabel = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const plural = (n, one, many) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

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

  const title = (badge) => <InlineStack gap="200" blockAlign="center"><span>Match products by meaning</span>{badge}</InlineStack>;
  const what = "Shoppers asking for “shoes for standing all day” also find arch-support styles that don't use those words.";

  if (!provider) {
    return (
      <Card padding="0">
        <Row title={title(<Badge>Off</Badge>)} help={`${what} Turn it on in Settings → Integrations → Semantic search.`} />
      </Card>
    );
  }

  const remaining = Math.max(0, (productsCount || 0) - displayEmbedded);
  const percent = (productsCount || 0) > 0
    ? Math.min(100, Math.round((displayEmbedded / productsCount) * 100))
    : 0;

  return (
    <Card padding="0">
      <Row
        title={title(<Badge tone={remaining === 0 ? "success" : "info"}>{provider === "voyage" ? "Voyage AI" : "OpenAI"}</Badge>)}
        help={`${what} New and updated products are added automatically.`}
        control={
          <Button onClick={startBackfill} loading={isBackfilling} disabled={(remaining === 0 && !result?.error) || isReembedding}>
            {remaining === 0 ? "All products added" : `Add ${remaining.toLocaleString()} missing`}
          </Button>
        }
      >
        <BlockStack gap="300">
          <div className="ct-progress">
            <div className="ct-progress__text">
              <span>{`${displayEmbedded.toLocaleString()} of ${(productsCount || 0).toLocaleString()} products searchable by meaning`}</span>
              <span>{percent}%</span>
            </div>
            <div className="ct-bar" role="progressbar" aria-label="Products searchable by meaning" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${percent}%` }} />
            </div>
          </div>
          {result?.error && (
            <Banner tone="critical">{result.error}</Banner>
          )}
          {result?.backfilled && !result.error && (
            <Banner tone="success">
              Added {result.processed?.toLocaleString() || 0} product
              {result.processed === 1 ? "" : "s"}.
              {result.failed > 0 ? ` ${result.failed} failed.` : ""}
              {result.remaining > 0 ? ` ${result.remaining.toLocaleString()} remaining — run it again.` : ""}
            </Banner>
          )}
          {result?.reembedded && !result.error && (
            <Banner tone="success">
              Re-embedded {result.processed?.toLocaleString() || 0} product
              {result.processed === 1 ? "" : "s"} with fresh catalog data.
              {result.failed > 0 ? ` ${result.failed} failed.` : ""}
            </Banner>
          )}
          <InlineStack gap="200" blockAlign="center" wrap>
            <Button
              onClick={startReembed}
              loading={isReembedding}
              disabled={isBackfilling || (productsCount || 0) === 0}
              tone="critical"
              variant="plain"
            >
              Re-embed all
            </Button>
            <span className="ct-help">After product fields change, the metaobject scope is granted, or bulk edits — those don't refresh on their own.</span>
          </InlineStack>
        </BlockStack>
      </Row>
    </Card>
  );
}

function MetafieldRow({ row, onAdd, onRemove, busy }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(row.attribute || "");
  return (
    <Row
      title={
        <InlineStack gap="200" blockAlign="center">
          <span>{row.name}</span>
          {row.status === "automatic" && <Badge tone="success" size="small">Used automatically</Badge>}
          {row.status === "added" && <Badge tone="success" size="small">{`Added as "${row.attribute}"`}</Badge>}
          {row.target === "variant" && <Badge size="small">Per size/color</Badge>}
        </InlineStack>
      }
      help={
        <>
          {[row.typeLabel, row.count ? `filled in on ${row.count.toLocaleString()} product${row.count === 1 ? "" : "s"}` : "", row.why]
            .filter(Boolean).join(" · ")}
          {row.description && row.description !== row.name ? ` — ${row.description}` : ""}
        </>
      }
      control={
        row.status === "available" && !editing ? (
          <InlineStack gap="100" wrap={false}>
            <Button size="slim" onClick={() => onAdd(row, row.attribute)} loading={busy}>Add</Button>
            <Button size="slim" variant="tertiary" onClick={() => setEditing(true)}>Rename</Button>
          </InlineStack>
        ) : row.status === "added" ? (
          <Button size="slim" variant="tertiary" tone="critical" onClick={() => onRemove(row.attribute)} loading={busy}>Remove</Button>
        ) : null
      }
    >
      {editing ? (
        <InlineStack gap="200" blockAlign="end" wrap={false}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TextField
              label="Name the assistant uses"
              value={name}
              onChange={setName}
              autoComplete="off"
              helpText="Lowercase words, e.g. heel_height. We picked one for you."
            />
          </div>
          <Button variant="primary" disabled={!name.trim()} loading={busy} onClick={() => { onAdd(row, name); setEditing(false); }}>Add</Button>
          <Button variant="tertiary" onClick={() => setEditing(false)}>Cancel</Button>
        </InlineStack>
      ) : null}
    </Row>
  );
}

function AttributeMappingsCard({ mappings, choices = [], choicesError = null }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const lastError = fetcher.data?.error;
  const lastSaved = fetcher.data?.saved;
  const [search, setSearch] = useState("");
  const [showOther, setShowOther] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(choices.length === 0);

  // Manual form (advanced): tag prefixes, or a metafield that has no definition.
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

  const submit = (fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("autoSync", "1");
    fetcher.submit(fd, { method: "post" });
  };
  const addFromPicker = (row, name) => submit({
    intent: "save_mapping",
    attribute: name,
    sourceType: "metafield",
    target: row.target,
    namespace: row.namespace,
    key: row.key,
    prefix: "",
  });
  const handleDelete = (attr) => submit({ intent: "delete_mapping", attribute: attr });
  const addAllRecommended = () => submit({
    intent: "save_mappings_bulk",
    items: JSON.stringify(
      choices
        .filter((r) => r.group === "recommended")
        .map((r) => ({ attribute: r.attribute, target: r.target, namespace: r.namespace, key: r.key })),
    ),
  });
  const handleManualSave = () => submit({ intent: "save_mapping", attribute, sourceType, target, namespace, key, prefix });

  const canSave =
    attribute.trim().length > 0 &&
    ((sourceType === "metafield" && namespace.trim() && key.trim()) ||
      (sourceType === "tag_prefix" && prefix.trim()));

  const q = search.trim().toLowerCase();
  const matches = (r) => !q || `${r.name} ${r.namespace}.${r.key} ${r.description}`.toLowerCase().includes(q);
  const visible = choices.filter(matches);
  const inUse = visible.filter((r) => r.group === "in_use");
  const recommended = visible.filter((r) => r.group === "recommended");
  const other = visible.filter((r) => r.group === "other");
  const hiddenCount = choices.filter((r) => r.group === "hidden").length;
  // Mappings that don't come from a definition (tag prefixes, manual keys).
  const pickerIds = new Set(choices.filter((r) => r.status === "added").map((r) => r.attribute));
  const manualMappings = mappings.filter((m) => !pickerIds.has(m.attribute));
  const rowsOf = (list) => list.map((r) => <MetafieldRow key={r.id} row={r} onAdd={addFromPicker} onRemove={handleDelete} busy={busy} />);

  const banners = [
    fetcher.data?.syncStarted ? (
      <Banner key="ok" tone="success">
        <p>
          {fetcher.data.savedAttribute ? `Added "${fetcher.data.savedAttribute}". ` : "Saved. "}
          Updating your products in the background — this takes about a minute.
        </p>
      </Banner>
    ) : null,
    lastError ? <Banner key="err" tone="critical"><p>{lastError}</p></Banner> : null,
    choicesError ? (
      <Banner key="load" tone="warning">
        <p>We couldn't load your store's fields from Shopify ({choicesError}). You can still add one by hand under Advanced.</p>
      </Banner>
    ) : null,
  ].filter(Boolean);

  return (
    <Card padding="0">
      {banners.length > 0 && <div className="ct-pad">{banners}</div>}

      {choices.length > 0 && (
        <>
          <div className="ct-tools">
            <div className="ct-search">
              <TextField
                label="Search your product fields"
                labelHidden
                size="slim"
                prefix={<Icon source={SearchIcon} tone="subdued" />}
                placeholder="Search fields, e.g. heel height"
                value={search}
                onChange={setSearch}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setSearch("")}
              />
            </div>
            {recommended.length > 0 && !q && (
              <Button variant="primary" onClick={addAllRecommended} loading={busy}>
                {`Add all recommended (${recommended.length})`}
              </Button>
            )}
          </div>

          {inUse.length > 0 && (
            <>
              <div className="ct-sub"><span className="ct-sub__label">{`In use · ${inUse.length}`}</span></div>
              {rowsOf(inUse)}
            </>
          )}

          {recommended.length > 0 && (
            <>
              <div className="ct-sub">
                <span className="ct-sub__label">{`Recommended · ${recommended.length}`}</span>
                <span className="ct-sub__help">Filled in on your products and useful for shoppers. Duplicates and internal fields are left out; extra fields don't slow answers down.</span>
              </div>
              {rowsOf(recommended)}
            </>
          )}
          {inUse.length + recommended.length === 0 && (
            <div className="ct-empty">No matching fields{q ? ` for "${search}"` : ""}.</div>
          )}

          {other.length > 0 && (
            <>
              <div className="ct-more">
                <Button variant="plain" disclosure={showOther ? "up" : "down"} onClick={() => setShowOther((v) => !v)}>
                  {`${showOther ? "Hide" : "Show"} ${other.length} other field${other.length === 1 ? "" : "s"} (long text, internal IDs, rarely used)`}
                </Button>
              </div>
              {showOther && rowsOf(other)}
            </>
          )}
          {hiddenCount > 0 && !q && (
            <div className={other.length > 0 ? "ct-quiet" : "ct-more ct-help"}>
              {`${hiddenCount} more field${hiddenCount === 1 ? " is" : "s are"} hidden — empty on every product, added by other apps, or links to other records.`}
            </div>
          )}
        </>
      )}

      <div className="ct-more">
        <Button variant="plain" disclosure={showAdvanced ? "up" : "down"} onClick={() => setShowAdvanced((v) => !v)}>
          Advanced: tag prefixes or a field that isn't listed
        </Button>
      </div>
      {showAdvanced && (
        <>
          {manualMappings.map((m) => (
            <Row
              key={m.id}
              title={m.attribute}
              help={m.sourceType === "metafield" ? `Metafield ${m.namespace}.${m.key}` : `Tags starting with “${m.prefix}”`}
              control={<Button size="slim" variant="tertiary" tone="critical" onClick={() => handleDelete(m.attribute)}>Remove</Button>}
            />
          ))}
          <Row stack>
            <BlockStack gap="300">
              <div className="set-grid set-grid--3">
                <TextField label="Attribute name" value={attribute} onChange={setAttribute}
                  helpText="The name the assistant uses (e.g. material, heel_height)." autoComplete="off" />
                <Select label="Comes from"
                  options={[{ label: "Metafield", value: "metafield" }, { label: "Product tags with a prefix", value: "tag_prefix" }]}
                  value={sourceType} onChange={setSourceType} />
                <Select label="Level"
                  options={[{ label: "Product", value: "product" }, { label: "Variant (per size/color)", value: "variant" }]}
                  value={target} onChange={setTarget}
                  disabled={sourceType === "tag_prefix"} />
              </div>
              {sourceType === "metafield" ? (
                <div className="set-grid">
                  <TextField label="Namespace" value={namespace} onChange={setNamespace} placeholder="custom" autoComplete="off" />
                  <TextField label="Key" value={key} onChange={setKey} placeholder="material" autoComplete="off" />
                </div>
              ) : (
                <div style={{ maxWidth: 360 }}>
                  <TextField label="Tag prefix" value={prefix} onChange={setPrefix} placeholder="material:"
                    helpText="Tags like 'material:leather' become material = leather." autoComplete="off" />
                </div>
              )}
              <InlineStack>
                <Button loading={busy} disabled={!canSave} onClick={handleManualSave}>Add</Button>
              </InlineStack>
            </BlockStack>
          </Row>
        </>
      )}
    </Card>
  );
}

const COVERAGE_TONE = { good: "success", partial: "attention", missing: "critical", info: "info" };
const COVERAGE_LABEL = { good: "Ready", partial: "Partial", missing: "Missing", info: "None set" };

function CatalogCoverageCard({ coverage }) {
  return (
    <Group
      title="What the assistant can filter on"
      badge={coverage.gaps.length > 0 ? <Badge tone="attention">{`${coverage.gaps.length} to improve`}</Badge> : <Badge tone="success">Ready</Badge>}
    >
      <div className="ct-pad">
        <div className="ct-help">
          Share of active products with each field, and where the value comes from. Products a field doesn't apply to (orthotics have no color) are left out.
          Common metafields like <code>custom.color</code> are detected during sync; a mapping under Product fields always wins.
        </div>
        {coverage.gaps.length > 0 && (
          <Banner tone="warning">
            <p>
              Limited data for <strong>{coverage.gaps.join(", ")}</strong>. Requests that depend on these
              (for example “red shoes” or “women's sandals”) may miss products. Fill the field in Shopify or add it
              under Product fields, then click <strong>Resync now</strong>.
            </p>
          </Banner>
        )}
      </div>
      <div style={{ height: 12 }} />
      <div className="ct-cov ct-cov--head" aria-hidden="true">
        <span>Field</span><span>Products</span><span>Comes from</span><span style={{ justifySelf: "end" }}>Status</span>
      </div>
      {coverage.rows.map((r) => {
        const na = Object.entries(r.notApplicable || {});
        const from = Object.entries(r.sources)
          .sort((a, b) => b[1] - a[1])
          .map(([src, n]) => `${COVERAGE_SOURCE_LABELS[src] || src} (${n})`)
          .join(", ");
        return (
          <div className="ct-cov" key={r.key}>
            <div>
              <div className="ct-cov__name">{r.label}</div>
              <div className="ct-cov__use">{r.use}</div>
            </div>
            <div className="ct-cov__bar">
              <div className="ct-cov__num"><span>{`${r.covered.toLocaleString()} / ${r.total.toLocaleString()}`}</span><span>{`${r.pct}%`}</span></div>
              <div className={`ct-bar ct-bar--${r.status}`}><span style={{ width: `${r.pct}%` }} /></div>
              {na.length > 0 && <div className="ct-cov__na">{`Doesn't apply to ${na.map(([c, n]) => `${c} (${n})`).join(", ")}`}</div>}
            </div>
            <div className="ct-cov__src">{from || "—"}</div>
            <div className="ct-cov__status"><Badge tone={COVERAGE_TONE[r.status]}>{COVERAGE_LABEL[r.status]}</Badge></div>
          </div>
        );
      })}
    </Group>
  );
}

function CatalogSyncCard({ data }) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const mounted = useMounted();
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
  const active = data.status === "running" || data.status === "stopping";
  const badge = active
    ? <Badge tone="info">Syncing</Badge>
    : data.status === "error"
      ? <Badge tone="critical">Last sync failed</Badge>
      : data.lastSyncedAt ? <Badge tone="success">Up to date</Badge> : <Badge>Not synced yet</Badge>;
  const when = mounted
    ? [
      data.lastSyncedAt ? `Last full sync ${timeLabel(data.lastSyncedAt)}` : "No full sync yet",
      data.nextScheduledSyncAt ? `next ${timeLabel(data.nextScheduledSyncAt)}` : "",
    ].filter(Boolean).join(" · ")
    : "";

  return (
    <Card padding="0">
      <Row
        title={<InlineStack gap="200" blockAlign="center"><span>{`${plural(data.productsCount || 0, "product", "products")} indexed`}</span>{badge}</InlineStack>}
        help={
          <>
            {when ? `${when}. ` : ""}
            {active
              ? "Syncing now — the assistant keeps using the current catalog until it's done."
              : "Product edits sync within seconds; a full check runs nightly."}
          </>
        }
        control={
          active ? (
            <Button variant="plain" tone="critical" loading={isStopping} onClick={handleStop}>
              {isStopping ? "Stopping..." : "Stop sync"}
            </Button>
          ) : (
            <Button loading={isRunning} onClick={handleResync}>Resync now</Button>
          )
        }
      >
        {(active && syncedSoFar > 0) || data.lastError ? (
          <BlockStack gap="300">
            {active && syncedSoFar > 0 && (
              <div className="ct-progress">
                <div className="ct-progress__text">
                  <span>{isStopping ? "Stopping..." : `${syncedSoFar.toLocaleString()} products synced${pct !== null ? ` of ${estimate.toLocaleString()}` : ""}…`}</span>
                  {pct !== null && <span>{pct}%</span>}
                </div>
                {pct !== null && (
                  <div className="ct-bar" role="progressbar" aria-label="Sync progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            )}
            {data.lastError && (
              <Banner tone="critical" title="Last sync failed"><p>{data.lastError}</p></Banner>
            )}
          </BlockStack>
        ) : null}
      </Row>
    </Card>
  );
}

function DisplayCard({ productCardStyle }) {
  const styleFetcher = useFetcher();
  const handleStyleChange = (value) => {
    const fd = new FormData();
    fd.set("intent", "set_card_style");
    fd.set("productCardStyle", value);
    styleFetcher.submit(fd, { method: "post" });
  };
  return (
    <Group title="Product cards in the chat">
      <Row stack>
        <BlockStack gap="300">
          <Select
            label="Card style"
            options={[
              { label: "Compact — image left, info right (up to 3 cards)", value: "horizontal" },
              { label: "Showcase — square image on top, scrollable row (up to 10 cards)", value: "showcase" },
            ]}
            value={productCardStyle || "horizontal"}
            onChange={handleStyleChange}
            disabled={styleFetcher.state === "submitting"}
            helpText="Compact suits 1–3 strong matches. Showcase is a swipeable row of larger square cards — good for browsing and comparing."
          />
          <div className="ct-note">
            <strong>One card per style.</strong> Products that differ only by color show as one card, with the other colors offered
            alongside. Titles are grouped by everything before the last dash — <code>Product Name - Color</code>, e.g.{" "}
            <code>Chase Arch Support Sneaker - Black</code> and <code>Chase Arch Support Sneaker - White</code> → one card.
          </div>
        </BlockStack>
      </Row>
    </Group>
  );
}

const SPEC_FINDS = [
  ["removable_footbed", "Removable footbed", "for their own orthotics"],
  ["no_pig_products", "No pig products", "listed in the materials"],
  ["slip_resistant", "Slip resistant", "work and wet floors"],
  ["metatarsal_pad", "Metatarsal pad", "ball-of-foot support"],
];

function saveBlob(fileName, content) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ProductSpecsCard({ specs, maxBytes }) {
  const fetcher = useFetcher();
  const files = useFetcher();
  const input = useRef(null);
  const mounted = useMounted();
  const [problem, setProblem] = useState("");
  const [reading, setReading] = useState(false);
  const [dismissed, setDismissed] = useState(null);
  const sheet = specs?.sheet || null;
  const match = specs?.match || null;
  const finds = specs?.finds || {};
  const busy = fetcher.state !== "idle" || reading;
  const uploading = busy && (reading || fetcher.formData?.get("intent") === "upload_specs");
  const removing = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "remove_specs";
  const downloading = files.state !== "idle" ? String(files.formData?.get("kind") || "") : "";

  const lastFile = useRef(null);
  useEffect(() => {
    const d = files.data?.download;
    if (d && d.fileName && typeof d.content === "string" && lastFile.current !== d) {
      lastFile.current = d;
      saveBlob(d.fileName, d.content);
    }
  }, [files.data]);

  const pick = () => { setProblem(""); input.current?.click(); };
  const onFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    setProblem("");
    if (!file) return;
    if (!/\.(xlsx|csv)$/i.test(file.name)) { setProblem("Choose an Excel workbook (.xlsx) or a CSV file."); return; }
    if (file.size > maxBytes) { setProblem(`That file is too large — the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`); return; }
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      setReading(false);
      const fd = new FormData();
      fd.set("intent", "upload_specs");
      fd.set("fileName", file.name);
      fd.set("data", String(reader.result || ""));
      fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
    };
    reader.onerror = () => { setReading(false); setProblem("That file couldn't be read. Try again."); };
    reader.readAsDataURL(file);
  };
  const remove = () => {
    if (!window.confirm("Remove the spec sheet? The assistant stops using its specs right away. Facts on your product pages stay.")) return;
    fetcher.submit({ intent: "remove_specs" }, { method: "post" });
  };
  const download = (kind) => files.submit({ intent: "download_specs", kind }, { method: "post" });

  const result = fetcher.data;
  const notice = problem
    ? { tone: "critical", text: problem }
    : result?.specsError ? { tone: "critical", text: result.specsError }
      : result?.specsSaved ? { tone: "success", text: `Sheet saved. ${result.specsMatched.toLocaleString()} of ${result.specsProducts.toLocaleString()} products now have specs — the assistant uses them from the next message.` }
        : result?.specsRemoved ? { tone: "info", text: "Spec sheet removed." } : null;
  const noticeKey = notice ? `${notice.tone}:${notice.text}` : "";
  const matched = match ? match.byCode + match.byStyle : 0;
  const pct = match?.products ? Math.round((matched / match.products) * 100) : 0;
  const toCheck = match ? [
    match.missing ? `${plural(match.missing, "product isn't", "products aren't")} in the sheet${match.missingStyles.length ? ` (${match.missingStyles.join(", ")}${match.missingStyleCount > match.missingStyles.length ? "…" : ""})` : ""}` : "",
    match.nameMismatch ? `${plural(match.nameMismatch, "product's style name is", "products' style names are")} spelled differently in the sheet` : "",
    match.left ? `${plural(match.left, "value was", "values were")} left out — the product page says otherwise, or the sheet lists a style twice with different values` : "",
    sheet?.duplicates ? `${plural(sheet.duplicates, "code is", "codes are")} listed twice with different values` : "",
    sheet?.odd ? `${plural(sheet.odd, "value was", "values were")} left out — not readable or not possible (e.g. a 245 mm drop)` : "",
  ].filter(Boolean) : [];

  return (
    <Group
      title="Spec sheet"
      badge={sheet ? <Badge tone="success">In use</Badge> : <Badge>None yet</Badge>}
    >
      <input ref={input} type="file" accept=".xlsx,.csv" onChange={onFile} style={{ display: "none" }} aria-hidden="true" tabIndex={-1} />
      <Row
        title={sheet ? sheet.fileName : "Upload your technical sheet"}
        help={sheet
          ? `${mounted && sheet.updatedAt ? `Uploaded ${timeLabel(sheet.updatedAt)} · ` : ""}${plural(sheet.codes, "style code", "style codes")} from ${plural(sheet.tabsUsed, "tab", "tabs")}.${sheet.tabsSkipped.length ? ` Not used: ${sheet.tabsSkipped.join("; ")}.` : ""}`
          : "An Excel workbook (every tab is read) or a CSV with a style code column — “Style #” — and columns like Removable Depth, Contains Pig Products, Shank, Lining, Heel to Toe Drop, Shaft Height, Temperature Rating, Slip Resistant."}
        control={
          <InlineStack gap="300" blockAlign="center" wrap={false}>
            {sheet && <Button variant="plain" tone="critical" onClick={remove} loading={removing} disabled={busy && !removing}>Remove</Button>}
            <Button onClick={pick} loading={uploading} disabled={busy && !uploading}>{sheet ? "Replace" : "Upload sheet"}</Button>
          </InlineStack>
        }
      >
        {notice && dismissed !== noticeKey ? (
          <Banner tone={notice.tone} onDismiss={() => setDismissed(noticeKey)}><p>{notice.text}</p></Banner>
        ) : null}
      </Row>

      {sheet && match ? (
        <>
          <div className="ct-sub"><span className="ct-sub__label">Coverage</span></div>
          <div className="ct-pad ct-spec-cov">
            <div className="ct-cov__num"><span>{`${matched.toLocaleString()} of ${plural(match.products, "product", "products")} have specs`}</span><span>{`${pct}%`}</span></div>
            <div className={`ct-bar${pct < 50 ? " ct-bar--partial" : ""}`}><span style={{ width: `${pct}%` }} /></div>
            <div className="ct-help">
              {`${match.byCode.toLocaleString()} by their exact code · ${match.byStyle.toLocaleString()} by their style — their colorway isn't in the sheet, so only what's the same in every color is used (not pig products or materials).`}
            </div>
          </div>
          <div style={{ height: 12 }} />
        </>
      ) : null}

      {sheet ? (
        <Row
          title="What shoppers can ask for now"
          help="In-stock products each search filter finds. Products that don't list a spec are never assumed to have it."
        >
          <div className="ct-finds">
            {SPEC_FINDS.map(([k, label, hint]) => (
              <div className="ct-find" key={k}>
                <span className="ct-find__n">{Number(finds[k] || 0).toLocaleString()}</span>
                <span className="ct-find__label">{label}</span>
                {hint ? <span className="ct-find__hint">{hint}</span> : null}
              </div>
            ))}
          </div>
        </Row>
      ) : null}

      {sheet && toCheck.length ? (
        <Row
          title="To check"
          help={<ul className="ct-list">{toCheck.map((t) => <li key={t}>{t}</li>)}</ul>}
          control={<Button onClick={() => download("report")} loading={downloading === "report"}>Download list</Button>}
        />
      ) : null}

      {sheet ? (
        <Row
          title="For your Shopify product pages"
          help="The handle plus one column per spec (custom.removable_footbed_depth, custom.contains_pig_products…), only what your product pages don't already show. In Shopify: add these product metafield definitions (Settings → Custom data → Products, single line text), then Products → Import with “Overwrite products with matching handles”. Try a few rows first."
          control={<Button onClick={() => download("shopify")} loading={downloading === "shopify"}>Download CSV</Button>}
        />
      ) : null}

      {sheet ? (
        <Row
          title="Cleaned sheet"
          help="Every code with one wording per value — to share with your product team, or to fix and upload again."
          control={<Button variant="plain" onClick={() => download("clean")} loading={downloading === "clean"}>Download</Button>}
        />
      ) : null}
    </Group>
  );
}

// Attributes that already scope every similar-products lookup.
const SIMILAR_ALWAYS = new Set(["gender", "category", "category_for_filter"]);

function SimilarMatchAttributesCard({ initial, attributeKeys = [] }) {
  const fetcher = useFetcher();
  const [attrs, setAttrs] = useState(initial || []);
  const [input, setInput] = useState("");
  const [showManual, setShowManual] = useState(attributeKeys.length === 0);
  // Ticked ones first, as they were when the page opened — a box doesn't
  // jump away from the pointer when it's ticked.
  const [firstPicked] = useState(() => new Set((initial || []).map((a) => String(a).toLowerCase())));

  const save = (list) => {
    const fd = new FormData();
    fd.set("intent", "save_similar_attrs");
    fd.set("similarMatchAttributes", JSON.stringify(list));
    fetcher.submit(fd, { method: "post" });
  };
  const has = (k) => attrs.some((a) => a.toLowerCase() === String(k).toLowerCase());
  const toggle = (k, on) => {
    const updated = on ? (has(k) ? attrs : [...attrs, k]) : attrs.filter((a) => a.toLowerCase() !== String(k).toLowerCase());
    setAttrs(updated);
    save(updated);
  };
  const addManual = () => {
    const v = input.trim();
    if (!v) return;
    setInput("");
    if (!has(v)) toggle(v, true);
  };

  // Only fields that can sensibly match (short, shared values).
  const options = similarityOptions(attributeKeys, attrs, SIMILAR_ALWAYS)
    .sort((a, b) => Number(firstPicked.has(String(b.key).toLowerCase())) - Number(firstPicked.has(String(a.key).toLowerCase())));
  const extra = attrs.filter((a) => !options.some((r) => String(r.key).toLowerCase() === a.toLowerCase()));

  return (
    <Group
      title="“Show me something similar”"
      badge={attrs.length > 0 ? <Badge tone="success">{`${attrs.length} ticked`}</Badge> : <Badge>Off</Badge>}
    >
      <Row stack help="When a shopper asks for “something like this one” or “similar but cheaper”, the assistant shows other styles from the same category and gender that share what you tick. Nothing ticked turns this off.">
        <BlockStack gap="300">
          {options.length > 0 ? (
            <div className="ct-ticks">
              {options.map((r) => (
                <Checkbox
                  key={r.key}
                  label={String(r.key).replace(/_/g, " ")}
                  helpText={`On ${Number(r.n).toLocaleString()} product${r.n === 1 ? "" : "s"}`}
                  checked={has(r.key)}
                  onChange={(on) => toggle(r.key, on)}
                />
              ))}
            </div>
          ) : (
            <Text as="p" tone="subdued">
              No product fields found yet. Add some under <strong>Product fields</strong> above, then come back.
            </Text>
          )}

          {extra.length > 0 && (
            <InlineStack gap="200" wrap>
              {extra.map((a) => <Tag key={a} onRemove={() => toggle(a, false)}>{a}</Tag>)}
            </InlineStack>
          )}

          <InlineStack gap="300" blockAlign="center">
            <Button variant="plain" disclosure={showManual ? "up" : "down"} onClick={() => setShowManual((v) => !v)}>
              Type a field name instead
            </Button>
            {fetcher.state !== "idle" && <Text as="span" variant="bodySm" tone="subdued">Saving…</Text>}
          </InlineStack>
          {showManual && (
            <InlineStack gap="200" blockAlign="end" wrap={false}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TextField label="Attribute name" value={input} onChange={setInput} placeholder="footbed" autoComplete="off" />
              </div>
              <Button onClick={addManual} disabled={!input.trim()}>Add</Button>
            </InlineStack>
          )}
        </BlockStack>
      </Row>
    </Group>
  );
}

export default function Catalog() {
  const data = useLoaderData();
  return (
    <Page>
      <TitleBar title="Catalog" />
      {/* Static CSS, injected as-is: as a text child React would escape its
          quotes on the server and the page wouldn't hydrate. */}
      <style dangerouslySetInnerHTML={{ __html: SETTINGS_CSS + CATALOG_CSS }} />
      <div className="ct set-links">
        <BlockStack gap="600">
          <BrandHeader title="Catalog" gutter={false} />

          <section>
            <SectionHead title="Your products">
              The assistant reads your Shopify products and stays in sync as you edit them. You only need to act if something looks out of date.
            </SectionHead>
            <BlockStack gap="400">
              <CatalogSyncCard data={data} />
              {data.coverage && <CatalogCoverageCard coverage={data.coverage} />}
            </BlockStack>
          </section>

          <section>
            <SectionHead title="Product fields">
              The Shopify fields (metafields) the assistant uses — material, footbed, heel height. Add one and the assistant can filter by it (“show me cork footbeds”) and answer questions about it; your products update on their own.
            </SectionHead>
            <AttributeMappingsCard mappings={data.mappings} choices={data.metafieldChoices || []} choicesError={data.metafieldError} />
          </section>

          <section>
            <SectionHead title="Product specs">
              Your technical sheet — removable footbed, pig products, shank, lining, heel-to-toe drop, boot shaft, temperature rating and more, by style code. The assistant answers spec questions from it and can find, for example, shoes for custom orthotics. What a product page already says always wins.
            </SectionHead>
            <ProductSpecsCard specs={data.specs} maxBytes={data.specFileMaxBytes} />
          </section>

          <section>
            <SectionHead title="Recommendations and product cards">
              What “similar” means for your products, and how cards look in the chat.
            </SectionHead>
            <div className="ct-two">
              <SimilarMatchAttributesCard initial={data.similarMatchAttributes} attributeKeys={data.attributeKeys || []} />
              <DisplayCard productCardStyle={data.productCardStyle} />
            </div>
          </section>

          <SemanticSearchCard
            provider={data.embeddingProvider}
            embeddedCount={data.embeddedCount}
            productsCount={data.productsCount}
          />
        </BlockStack>
      </div>
    </Page>
  );
}
