import { useEffect, useState } from "react";
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
  Box,
  Divider,
  FormLayout,
  TextField,
  Select,
  Tag,
  DataTable,
  ProgressBar,
  Checkbox,
} from "@shopify/polaris";
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
import { nextScheduledSyncAt } from "../lib/catalog-sync-scheduler.server";
import { similarityOptions } from "../lib/similar-attributes.js";


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

  return {
    shop: session.shop,
    attributeKeys,
    coverage,
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

  
  
  
  
  
  
  return { error: "unknown intent" };
};


function formatTime(iso) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}



function statusBadge(status) {
  if (status === "running") return <Badge tone="info">Syncing</Badge>;
  if (status === "error") return <Badge tone="critical">Error</Badge>;
  return <Badge tone="success">Idle</Badge>;
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


function MetafieldRow({ row, onAdd, onRemove, busy }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(row.attribute || "");
  return (
    <Box paddingBlock="200" borderBlockEndWidth="025" borderColor="border-secondary">
      <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
        <BlockStack gap="050">
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="bodyMd" fontWeight="semibold">{row.name}</Text>
            {row.status === "automatic" && <Badge tone="success">Used automatically</Badge>}
            {row.status === "added" && <Badge tone="success">{`Added as "${row.attribute}"`}</Badge>}
            {row.target === "variant" && <Badge>Per size/color</Badge>}
          </InlineStack>
          <Text as="span" variant="bodySm" tone="subdued">
            {[row.typeLabel, row.count ? `filled in on ${row.count.toLocaleString()} product${row.count === 1 ? "" : "s"}` : "", row.why]
              .filter(Boolean).join(" · ")}
            {row.description && row.description !== row.name ? ` — ${row.description}` : ""}
          </Text>
        </BlockStack>
        {row.status === "available" && !editing && (
          <InlineStack gap="200" wrap={false}>
            <Button size="slim" onClick={() => onAdd(row, row.attribute)} loading={busy}>Add</Button>
            <Button size="slim" variant="tertiary" onClick={() => setEditing(true)}>Rename</Button>
          </InlineStack>
        )}
        {row.status === "added" && (
          <Button size="slim" variant="tertiary" tone="critical" onClick={() => onRemove(row.attribute)} loading={busy}>Remove</Button>
        )}
      </InlineStack>
      {editing && (
        <Box paddingBlockStart="200">
          <InlineStack gap="200" blockAlign="end" wrap={false}>
            <div style={{ flex: 1 }}>
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
        </Box>
      )}
    </Box>
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

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">Product attributes</Text>
          <Text as="p" tone="subdued">
            These are the fields on your products in Shopify. Click <strong>Add</strong> on any the assistant should know about —
            it can then filter by them ("show me cork footbeds") and answer questions about them. Your products update automatically.
          </Text>
        </BlockStack>

        {fetcher.data?.syncStarted && (
          <Banner tone="success">
            <p>
              {fetcher.data.savedAttribute ? `Added "${fetcher.data.savedAttribute}". ` : "Saved. "}
              Updating your products in the background — this takes about a minute.
            </p>
          </Banner>
        )}
        {lastError && <Banner tone="critical"><p>{lastError}</p></Banner>}
        {choicesError && (
          <Banner tone="warning">
            <p>We couldn't load your store's fields from Shopify ({choicesError}). You can still add one by hand under Advanced.</p>
          </Banner>
        )}

        {choices.length > 0 && (
          <>
            <TextField
              label="Search your product fields"
              labelHidden
              placeholder="Search fields (e.g. material, heel, width)"
              value={search}
              onChange={setSearch}
              autoComplete="off"
              clearButton
              onClearButtonClick={() => setSearch("")}
            />

            {inUse.length > 0 && (
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">In use</Text>
                {inUse.map((r) => <MetafieldRow key={r.id} row={r} onAdd={addFromPicker} onRemove={handleDelete} busy={busy} />)}
              </BlockStack>
            )}

            {recommended.length > 0 && !q && (
              <InlineStack align="space-between" blockAlign="center" gap="200">
                <Text as="p" tone="subdued" variant="bodySm">
                  Not sure? Add every recommended field — duplicates and internal fields are already left out, and extra fields don't slow answers down.
                </Text>
                <Button variant="primary" onClick={addAllRecommended} loading={busy}>
                  {`Add all recommended (${recommended.length})`}
                </Button>
              </InlineStack>
            )}

            {recommended.length > 0 && (
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">Recommended to add</Text>
                <Text as="p" variant="bodySm" tone="subdued">Filled in on your products and useful for shoppers.</Text>
                {recommended.map((r) => <MetafieldRow key={r.id} row={r} onAdd={addFromPicker} onRemove={handleDelete} busy={busy} />)}
              </BlockStack>
            )}
            {inUse.length + recommended.length === 0 && (
              <Text as="p" tone="subdued">No matching fields{q ? ` for "${search}"` : ""}.</Text>
            )}

            {other.length > 0 && (
              <BlockStack gap="100">
                <Button variant="plain" disclosure={showOther ? "up" : "down"} onClick={() => setShowOther((v) => !v)}>
                  {`${showOther ? "Hide" : "Show"} ${other.length} other field${other.length === 1 ? "" : "s"} (long text, internal IDs, rarely used)`}
                </Button>
                {showOther && other.map((r) => <MetafieldRow key={r.id} row={r} onAdd={addFromPicker} onRemove={handleDelete} busy={busy} />)}
              </BlockStack>
            )}
            {hiddenCount > 0 && !q && (
              <Text as="p" variant="bodySm" tone="subdued">
                {`${hiddenCount} more field${hiddenCount === 1 ? " is" : "s are"} hidden — empty on every product, added by other apps, or links to other records.`}
              </Text>
            )}
          </>
        )}

        <Divider />
        <BlockStack gap="200">
          <Button variant="plain" disclosure={showAdvanced ? "up" : "down"} onClick={() => setShowAdvanced((v) => !v)}>
            Advanced: tag prefixes or a field that isn't listed
          </Button>
          {showAdvanced && (
            <BlockStack gap="300">
              {manualMappings.length > 0 && (
                <BlockStack gap="200">
                  {manualMappings.map((m) => (
                    <InlineStack key={m.id} align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">{m.attribute}</Text>
                        {m.sourceType === "metafield" ? (
                          <Tag>{`metafield: ${m.namespace}.${m.key}`}</Tag>
                        ) : (
                          <Tag>{`tag prefix: ${m.prefix}`}</Tag>
                        )}
                      </InlineStack>
                      <Button variant="tertiary" tone="critical" onClick={() => handleDelete(m.attribute)}>Remove</Button>
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
              <FormLayout>
                <FormLayout.Group>
                  <TextField label="Attribute name" value={attribute} onChange={setAttribute}
                    helpText="The name the assistant uses (e.g. material, heel_height)." autoComplete="off" />
                  <Select label="Comes from"
                    options={[{ label: "Metafield", value: "metafield" }, { label: "Product tags with a prefix", value: "tag_prefix" }]}
                    value={sourceType} onChange={setSourceType} />
                  <Select label="Level"
                    options={[{ label: "Product", value: "product" }, { label: "Variant (per size/color)", value: "variant" }]}
                    value={target} onChange={setTarget}
                    disabled={sourceType === "tag_prefix"} />
                </FormLayout.Group>
                {sourceType === "metafield" ? (
                  <FormLayout.Group>
                    <TextField label="Namespace" value={namespace} onChange={setNamespace} placeholder="custom" autoComplete="off" />
                    <TextField label="Key" value={key} onChange={setKey} placeholder="material" autoComplete="off" />
                  </FormLayout.Group>
                ) : (
                  <TextField label="Tag prefix" value={prefix} onChange={setPrefix} placeholder="material:"
                    helpText="Tags like 'material:leather' become material = leather." autoComplete="off" />
                )}
                <Button loading={busy} disabled={!canSave} onClick={handleManualSave}>Add</Button>
              </FormLayout>
            </BlockStack>
          )}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function CatalogCoverageCard({ coverage }) {
  const toneFor = { good: "success", partial: "attention", missing: "critical", info: "info" };
  const labelFor = { good: "Ready", partial: "Partial", missing: "Missing", info: "None set" };
  const rows = coverage.rows.map((r) => [
    <BlockStack gap="050" key={r.key}>
      <Text as="span" variant="bodyMd" fontWeight="semibold">{r.label}</Text>
      <Text as="span" variant="bodySm" tone="subdued">{r.use}</Text>
    </BlockStack>,
    <BlockStack gap="050" key={`${r.key}-n`}>
      <Text as="span" variant="bodyMd">{`${r.covered} / ${r.total} (${r.pct}%)`}</Text>
      {Object.keys(r.notApplicable || {}).length > 0 && (
        <Text as="span" variant="bodySm" tone="subdued">
          {`Doesn't apply to ${Object.entries(r.notApplicable).map(([c, n]) => `${c} (${n})`).join(", ")}`}
        </Text>
      )}
    </BlockStack>,
    Object.entries(r.sources)
      .sort((a, b) => b[1] - a[1])
      .map(([src, n]) => `${COVERAGE_SOURCE_LABELS[src] || src} (${n})`)
      .join(", ") || "—",
    <Badge key={`${r.key}-status`} tone={toneFor[r.status]}>{labelFor[r.status]}</Badge>,
  ]);
  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">What the assistant can filter on</Text>
          <Text as="p" tone="subdued">
            Share of active products with each field, and where the value comes from. Kinds of products a field
            doesn't apply to (orthotics have no color) are left out and listed under the count. Common metafields
            (for example <code>custom.color</code>, <code>custom.gender_text</code>) are detected automatically
            during sync — a mapping below always takes priority.
          </Text>
        </BlockStack>
        {coverage.gaps.length > 0 && (
          <Banner tone="warning">
            <p>
              Limited data for <strong>{coverage.gaps.join(", ")}</strong>. Requests that depend on these
              (for example “red shoes” or “women's sandals”) may miss products. Fill the field in Shopify or add a
              mapping below, then click <strong>Resync now</strong>.
            </p>
          </Banner>
        )}
        <DataTable
          columnContentTypes={["text", "text", "text", "text"]}
          headings={["Field", "Products", "Comes from", "Status"]}
          rows={rows}
        />
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


function DisplayCard({ productCardStyle }) {
  const styleFetcher = useFetcher();
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

        <Box background="bg-surface-secondary" padding="300" borderRadius="200">
          <BlockStack gap="150">
            <Text as="p" variant="bodySm" tone="subdued">
              <strong>One card per style:</strong> products that differ only by color show as a single card, with the other colors offered alongside. The app groups products by everything before the last dash in the title, so titles should follow this format:
            </Text>
            <Text as="p" variant="bodySm">
              <code>Product Name - Color</code>
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Examples: <code>Chase Arch Support Sneaker - Black</code>, <code>Chase Arch Support Sneaker - White</code> → shown as one card.
            </Text>
          </BlockStack>
        </Box>
      </BlockStack>
    </Card>
  );
}


// Attributes that already scope every similar-products lookup.
const SIMILAR_ALWAYS = new Set(["gender", "category", "category_for_filter"]);

function SimilarMatchAttributesCard({ initial, attributeKeys = [] }) {
  const fetcher = useFetcher();
  const [attrs, setAttrs] = useState(initial || []);
  const [input, setInput] = useState("");
  const [showManual, setShowManual] = useState(attributeKeys.length === 0);

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

  // Only fields that can sensibly match (short, shared values) — chosen ones first.
  const options = similarityOptions(attributeKeys, attrs, SIMILAR_ALWAYS)
    .sort((a, b) => Number(has(b.key)) - Number(has(a.key)));
  const extra = attrs.filter((a) => !options.some((r) => String(r.key).toLowerCase() === a.toLowerCase()));

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">"Show me something similar"</Text>
          <Text as="p" tone="subdued">
            When a shopper asks for “something like this one” or “similar but cheaper”, the assistant shows other styles from
            the same category and gender that share the qualities you tick here. Only fields that can match between products
            are listed. Leave everything unticked to turn this off.
          </Text>
        </BlockStack>

        {fetcher.state !== "idle" && <Text as="p" variant="bodySm" tone="subdued">Saving…</Text>}

        {options.length > 0 ? (
          <BlockStack gap="100">
            {options.map((r) => (
              <Checkbox
                key={r.key}
                label={String(r.key).replace(/_/g, " ")}
                helpText={`On ${Number(r.n).toLocaleString()} product${r.n === 1 ? "" : "s"}`}
                checked={has(r.key)}
                onChange={(on) => toggle(r.key, on)}
              />
            ))}
          </BlockStack>
        ) : (
          <Text as="p" tone="subdued">
            No product attributes found yet. Add some on the <strong>Catalog</strong> page under "Product attributes", then come back.
          </Text>
        )}

        {extra.length > 0 && (
          <InlineStack gap="200" wrap>
            {extra.map((a) => <Tag key={a} onRemove={() => toggle(a, false)}>{a}</Tag>)}
          </InlineStack>
        )}

        <Button variant="plain" disclosure={showManual ? "up" : "down"} onClick={() => setShowManual((v) => !v)}>
          Type an attribute name instead
        </Button>
        {showManual && (
          <InlineStack gap="200" blockAlign="end" wrap={false}>
            <div style={{ flex: 1 }}>
              <TextField label="Attribute name" value={input} onChange={setInput} placeholder="footbed" autoComplete="off" />
            </div>
            <Button onClick={addManual} disabled={!input.trim()}>Add</Button>
          </InlineStack>
        )}
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


export default function Catalog() {
  const data = useLoaderData();
  return (
    <Page>
      <TitleBar title="Catalog" />
      <BrandHeader title="Catalog" />
      <BlockStack gap="800">
        <BlockStack gap="400">
          <SectionHeading
            title="Your products"
            description="The assistant reads your Shopify products automatically and stays in sync as you edit them. You only need to act if something looks out of date."
          />
          <CatalogSyncCard data={data} />
          {data.coverage && <CatalogCoverageCard coverage={data.coverage} />}
        </BlockStack>

        <BlockStack gap="400">
          <SectionHeading
            title="What the assistant knows about each product"
            description="Pick the product fields (metafields) the assistant should use — like material, footbed or heel height. Common ones are picked up automatically."
          />
          <AttributeMappingsCard mappings={data.mappings} choices={data.metafieldChoices || []} choicesError={data.metafieldError} />
        </BlockStack>

        <BlockStack gap="400">
          <SectionHeading
            title="Recommendations and product cards"
            description="What “similar” means for your products, and how cards look in the chat."
          />
          <SimilarMatchAttributesCard initial={data.similarMatchAttributes} attributeKeys={data.attributeKeys || []} />
          <DisplayCard productCardStyle={data.productCardStyle} />
        </BlockStack>

        <BlockStack gap="400">
          <SectionHeading
            title="Match products by meaning (optional)"
            description="With semantic search turned on in Settings, shoppers asking for 'shoes for standing all day' also find arch-support styles that don't use those words."
          />
          <SemanticSearchCard
            provider={data.embeddingProvider}
            embeddedCount={data.embeddedCount}
            productsCount={data.productsCount}
          />
        </BlockStack>
      </BlockStack>
    </Page>
  );
}
