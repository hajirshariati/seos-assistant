import { useEffect, useRef, useState } from "react";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Box,
  Text,
  Button,
  Badge,
  Banner,
  Divider,
  FormLayout,
  TextField,
  Checkbox,
  Select,
  DataTable,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";
import {
  listDecisionTrees,
  getDecisionTreeById,
  repairOrthoticIntent,
  saveDecisionTree,
  deleteDecisionTree,
} from "../models/DecisionTree.server";
import { validateDecisionTree } from "../lib/decision-tree-schema.server";
import {
  serializeMasterIndexToCsv,
  parseCsvToMasterIndex,
  diffMasterIndex,
} from "../lib/mapping-csv.server";
import { adminGraphql, syncOrthoticFinder } from "../lib/orthotic-finder.server";
import { cleanLineRules, lineRulesOf } from "../lib/orthotic-finder.js";
import BrandHeader from "../components/BrandHeader";
import { getShopPlan } from "../lib/billing.server";
import { safeExternalUrl } from "../lib/external-url.js";
import { PlanGate } from "../components/PlanGate";
import { RecommenderTables } from "../components/RecommenderEditor";
import { fitSummary, fitReadDue, startFitRead } from "../lib/fit-confidence.server";
import { reloadLeanCatalog } from "../lib/lean/catalog.server";
import { FIT_LABELS } from "../lib/fit-confidence.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  // Fix an orthotic finder saved with a placeholder ID (e.g. "a-z") so the
  // chat can find it — before listing, so the table shows the fixed ID.
  await repairOrthoticIntent(session.shop).catch(() => null);
  const [config, decisionTrees, plan] = await Promise.all([
    getShopConfig(session.shop),
    listDecisionTrees(session.shop),
    getShopPlan(session.shop),
  ]);
  // Fit confidence: what the last read found; a read starts on its own when
  // there's none yet or the daily one was missed.
  const fitEnabled = config.fitConfidenceEnabled !== false;
  let fit = await fitSummary(session.shop).catch(() => null);
  if (fitEnabled && fit && !fit.run.running && fitReadDue(fit)) {
    startFitRead(session.shop, { config });
    fit = { ...fit, run: { running: true, step: "products", done: 0, total: 0 } };
  }
  return {
    shop: session.shop,
    decisionTreeEnabled: config.decisionTreeEnabled === true,
    decisionTrees: decisionTrees.map((t) => ({
      ...t,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
      updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : t.updatedAt,
    })),
    fitPredictorEnabled: config.fitPredictorEnabled === true,
    // The auth header is a secret: the page only learns whether one is saved.
    fitPredictorConfig: (() => {
      try {
        const v = JSON.parse(config.fitPredictorConfig || "{}");
        if (!v || typeof v !== "object") return {};
        const { externalAuthHeader, ...rest } = v;
        return { ...rest, externalAuthHeaderSet: Boolean(externalAuthHeader) };
      } catch {
        return {};
      }
    })(),
    plan: { id: plan.id, name: plan.name, features: plan.features },
    fitConfidence: {
      enabled: fitEnabled,
      vip: config.vipModeEnabled === true,
      hasYotpo: Boolean(config.yotpoApiKey),
      hasAftership: Boolean(config.aftershipApiKey),
      ...(fit || { readAt: null, status: null, scored: 0, lowest: [], run: { running: false } }),
    },
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

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
    if (!treeIntent) return { error: "ID is required — for the orthotic finder use: orthotic" };
    let definition;
    try { definition = JSON.parse(definitionRaw); }
    catch { return { error: "Definition must be valid JSON." }; }
    // The finder's line rules, as the form sent them: only real lines and modes.
    if (definition?.kind === "catalog_finder" && definition.rules !== undefined) {
      definition.rules = cleanLineRules(definition.rules, definition.finder?.lines || []);
    }
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

  // CSV download/upload for the masterIndex (orthotic SKU mapping).
  // Lets merchants edit SKU rows in Excel/Sheets without touching JSON.
  // Only the masterIndex array is replaced — chip questions,
  // derivations, attribute prompts, and other tree fields stay
  // untouched on upload.
  if (intent === "export_mapping_csv") {
    const id = String(formData.get("id") || "").trim();
    if (!id) return { error: "Tree id required for export." };
    const tree = await getDecisionTreeById(session.shop, id);
    if (!tree) return { error: "Tree not found." };
    const masterIndex = tree.definition?.resolver?.masterIndex || [];
    const csv = serializeMasterIndexToCsv(masterIndex);
    const filename = `mapping-${tree.intent || "tree"}-${id.slice(0, 8)}.csv`;
    // Return CSV as JSON-wrapped string instead of a raw Response.
    // Raw POST fetch from the embedded admin iframe doesn't carry the
    // App Bridge session token, so the auth wrapper redirected to the
    // OAuth login HTML and the browser saved THAT as the "CSV" file.
    // Wrapping in JSON lets the client use useFetcher (which handles
    // session forwarding correctly) then build the Blob client-side.
    return { mappingCsvExport: { csv, filename } };
  }

  if (intent === "preview_upload_mapping_csv") {
    const id = String(formData.get("id") || "").trim();
    const csvText = String(formData.get("csv") || "");
    if (!id) return { error: "Tree id required." };
    if (!csvText.trim()) return { error: "CSV content is empty." };
    const tree = await getDecisionTreeById(session.shop, id);
    if (!tree) return { error: "Tree not found." };
    const parsed = parseCsvToMasterIndex(csvText);
    if (!parsed.ok) {
      return { mappingCsvPreview: { ok: false, errors: parsed.errors.slice(0, 20) } };
    }
    const oldIndex = tree.definition?.resolver?.masterIndex || [];
    const diff = diffMasterIndex(oldIndex, parsed.masterIndex);
    return {
      mappingCsvPreview: {
        ok: true,
        diff: {
          added: diff.added.length,
          removed: diff.removed.length,
          modified: diff.modified.length,
          // Sample first few of each for the UI to show
          addedSample: diff.added.slice(0, 5).map((r) => r.masterSku),
          removedSample: diff.removed.slice(0, 5).map((r) => r.masterSku),
          modifiedSample: diff.modified.slice(0, 5),
        },
        rowCount: parsed.masterIndex.length,
      },
    };
  }

  if (intent === "apply_upload_mapping_csv") {
    const id = String(formData.get("id") || "").trim();
    const csvText = String(formData.get("csv") || "");
    if (!id) return { error: "Tree id required." };
    if (!csvText.trim()) return { error: "CSV content is empty." };
    const tree = await getDecisionTreeById(session.shop, id);
    if (!tree) return { error: "Tree not found." };
    const parsed = parseCsvToMasterIndex(csvText);
    if (!parsed.ok) {
      return { error: "CSV validation failed: " + parsed.errors.slice(0, 4).join("; ") };
    }
    // Replace ONLY the masterIndex inside resolver — keep everything
    // else untouched (chip questions, derivations, attribute prompts,
    // root node id, etc.).
    const next = JSON.parse(JSON.stringify(tree.definition || {}));
    if (!next.resolver || typeof next.resolver !== "object") next.resolver = {};
    next.resolver.masterIndex = parsed.masterIndex;
    // Re-validate the full tree to make sure the new masterIndex
    // doesn't break schema invariants (e.g. references nodes need to
    // exist). validateDecisionTree is the same function used by the
    // JSON-textarea save path.
    const v = validateDecisionTree(next);
    if (!v.ok) {
      return { error: "Tree validation failed after applying CSV: " + v.errors.slice(0, 4).join("; ") };
    }
    try {
      const triggerPhrasesJson =
        typeof tree.triggerPhrases === "string"
          ? tree.triggerPhrases
          : JSON.stringify(tree.triggerPhrases || []);
      const saved = await saveDecisionTree(session.shop, {
        id: tree.id,
        name: tree.name,
        intent: tree.intent,
        triggerPhrases: triggerPhrasesJson,
        triggerCategoryGroup: tree.triggerCategoryGroup,
        definition: next,
        enabled: tree.enabled,
      });
      return {
        mappingCsvApplied: true,
        treeId: saved.id,
        rowCount: parsed.masterIndex.length,
        masterIndex: parsed.masterIndex,
      };
    } catch (err) {
      return { error: err?.message || "Could not save tree after CSV apply." };
    }
  }

  if (intent === "load_decision_tree") {
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

  // Rebuild the orthotic finder from the live catalog: every active orthotic,
  // grouped into its line, with arch and metatarsal pad read from Aetrex's
  // own SKU codes. Nothing to map by hand.
  if (intent === "sync_orthotic_finder") {
    try {
      // The library's admin client: its token is always current.
      const result = await syncOrthoticFinder({ shop: session.shop, graphql: adminGraphql(admin) });
      return result.ok ? { finderSynced: result } : { error: result.error };
    } catch (err) {
      return { error: "Sync failed: " + (err?.message || "unknown") };
    }
  }

  if (intent === "toggle_fit_confidence") {
    const value = formData.get("fitConfidenceEnabled") === "true";
    await updateShopConfig(session.shop, { fitConfidenceEnabled: value });
    // The cards show (or stop showing) it from the next message.
    reloadLeanCatalog(session.shop).catch(() => {});
    return { saved: true };
  }

  if (intent === "refresh_fit_confidence") {
    const config = await getShopConfig(session.shop);
    startFitRead(session.shop, { config });
    return { started: true };
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
          externalUrl: "",
          externalAuthHeader: "",
        };
        const url = typeof parsed.externalUrl === "string" ? parsed.externalUrl.trim() : "";
        if (url) {
          clean.externalUrl = safeExternalUrl(url);
          if (!clean.externalUrl) return { error: "The endpoint must be a public https:// address." };
          // Blank means "keep the saved header"; it's never sent to the page.
          const typed = typeof parsed.externalAuthHeader === "string" ? parsed.externalAuthHeader.trim() : "";
          let saved = "";
          const current = await getShopConfig(session.shop);
          try { saved = JSON.parse(current.fitPredictorConfig || "{}")?.externalAuthHeader || ""; } catch { /* none */ }
          clean.externalAuthHeader = typed || saved;
        }
        await updateShopConfig(session.shop, { fitPredictorConfig: JSON.stringify(clean) });
        return { saved: true };
      }
    } catch { /* */ }
    return { error: "Invalid fit predictor config." };
  }

  return { error: "Unknown action" };
};

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

// Single concise card that explains what the recommender does and
// what it protects against. Replaces the older 6-step + 8-tile pair
// which was thorough but too long for the page.
function HowItWorksCard() {
  const Bullet = ({ children }) => (
    <InlineStack gap="200" blockAlign="start" wrap={false}>
      <Text as="span" tone="success">●</Text>
      <Text as="span" variant="bodySm">{children}</Text>
    </InlineStack>
  );
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingMd">How it works</Text>
        <BlockStack gap="200">
          <Bullet>
            <strong>Built from your catalog.</strong> Every active orthotic is read
            from Shopify — its line, who it's for, what it's best for — and kept
            current every time the catalog syncs. Nothing to map by hand.
          </Bullet>
          <Bullet>
            <strong>Only the questions it needs.</strong> Who it's for, which
            shoes, arch type and ball-of-foot pain — skipping anything the
            shopper already said, with tap-to-answer choices.
          </Bullet>
          <Bullet>
            <strong>The AI picks the line, the rules pick the version.</strong> The
            assistant matches the shoes and needs to a line using each line's own
            “Best for”; the exact product then follows Aetrex's SKU rule
            (00/05 medium-high arch, 20/25 flat-low arch, 05/25 metatarsal pad).
          </Bullet>
          <Bullet>
            <strong>Honest when something doesn't exist.</strong> If a line has no
            version for that person (e.g. Work is men's only), the shopper is
            told and offered the closest line. Only products for sale are shown;
            kids only get kids' orthotics.
          </Bullet>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function DecisionTreesCard({ enabled, trees }) {
  const fetcher = useFetcher();
  const loadFetcher = useFetcher();
  const syncFetcher = useFetcher();
  const [editing, setEditing] = useState(null);  // { id?, name, intent, definition (object), ... }
  const [showMore, setShowMore] = useState(false);
  const [jsonDraft, setJsonDraft] = useState("");
  const [jsonError, setJsonError] = useState("");
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
        definition: t.definition || {},
      });
      setShowMore(false);
      setJsonError("");
    }
  }, [loadFetcher.data]);

  const syncFinder = () => {
    const fd = new FormData();
    fd.set("intent", "sync_orthotic_finder");
    syncFetcher.submit(fd, { method: "post" });
  };

  const toggleMaster = (next) => {
    const fd = new FormData();
    fd.set("intent", "toggle_decision_tree");
    fd.set("decisionTreeEnabled", next ? "true" : "false");
    fetcher.submit(fd, { method: "post" });
  };

  const startNew = () => {
    setEditing({
      id: null,
      name: "",
      intent: "",
      triggerPhrases: "",
      triggerCategoryGroup: "",
      enabled: false,
      // Smallest valid recommender: one question, one product row.
      definition: {
        rootNodeId: "q_gender",
        nodes: [
          {
            id: "q_gender", type: "question", attribute: "gender", skipIfKnown: true,
            question: "Who is this for?",
            chips: [{ label: "Men", value: "Men" }, { label: "Women", value: "Women" }],
            next: { _default: "q_resolve" },
          },
          { id: "q_resolve", type: "resolve" },
        ],
        resolver: {
          defaults: {},
          masterIndex: [{ masterSku: "", title: "", gender: "Women", useCase: "" }],
        },
      },
    });
    setShowMore(false);
    setJsonError("");
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
    fd.set("definition", JSON.stringify(editing.definition || {}));
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
    }
    // Runs when a save responds — not when the editor opens or closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const openAdvanced = () => {
    setJsonDraft(JSON.stringify(editing?.definition || {}, null, 2));
    setJsonError("");
    setShowMore((v) => !v);
  };
  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonDraft);
      setEditing((p) => ({ ...p, definition: parsed }));
      setJsonError("");
    } catch (e) {
      setJsonError(`Not valid JSON: ${e.message}`);
    }
  };

  const masterToggleSubmitting =
    fetcher.state === "submitting" &&
    fetcher.formData?.get?.("intent") === "toggle_decision_tree";

  return (
    <Card>
      <BlockStack gap="500">
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingMd">Manage recommenders</Text>
            <Checkbox
              label={enabled ? "Recommenders ON" : "Recommenders OFF"}
              checked={enabled}
              disabled={masterToggleSubmitting}
              onChange={(next) => toggleMaster(next)}
            />
          </InlineStack>
          <Text as="p" tone="subdued">
            When a shopper wants help choosing an orthotic, the assistant asks
            up to four tap-to-answer questions (who it's for, which shoes, arch
            type, ball-of-foot pain), picks the line that suits their shoes and
            then the exact version for their arch — and shows that one product.
            Setup: click <strong>Sync from Shopify</strong> once and switch this
            ON. Turned OFF, the assistant still recommends orthotics — just
            without the guided questions.
          </Text>
        </BlockStack>

        {fetcher.data?.error && (
          <Banner tone="critical">{fetcher.data.error}</Banner>
        )}

        <Divider />

        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text as="h4" variant="headingSm">Your recommenders</Text>
            <InlineStack gap="200" wrap>
              <Button onClick={startNew}>+ New recommender</Button>
              <Button
                onClick={syncFinder}
                variant="primary"
                loading={syncFetcher.state !== "idle"}
              >
                Sync from Shopify
              </Button>
            </InlineStack>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            <strong>Sync from Shopify</strong> reads every active product with
            product type “Orthotics”: its line, who it's for, what it's best for,
            and its arch and metatarsal version (from the SKU: 00/05 medium-high
            arch, 20/25 flat-low arch, 05/25 with metatarsal pad). It also
            refreshes on its own every time the catalog syncs.
          </Text>

          {(!trees || trees.length === 0) && (
            <Text as="p" tone="subdued">
              No recommenders yet. Click <strong>Sync from Shopify</strong> to
              build the orthotic finder from your catalog.
            </Text>
          )}

          {trees && trees.length > 0 && (
            <DataTable
              columnContentTypes={["text", "text", "numeric", "text"]}
              headings={["Name", "ID", "Times used", ""]}
              rows={trees.map((t) => [
                <Text key={`n-${t.id}`} as="span" fontWeight="semibold">{t.name}</Text>,
                <Text key={`i-${t.id}`} as="span" tone={t.intent === "orthotic" || /orthotic|insole/i.test(t.name || "") === false ? undefined : "critical"}>
                  {t.intent}{t.intent !== "orthotic" && /orthotic|insole/i.test(t.name || "") ? " — should be: orthotic" : ""}
                </Text>,
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

        {syncFetcher.data?.error && (
          <Banner tone="critical">{syncFetcher.data.error}</Banner>
        )}
        {syncFetcher.data?.finderSynced && (
          <Banner tone="success">
            <BlockStack gap="200">
              <Text as="p" fontWeight="semibold">
                Synced {syncFetcher.data.finderSynced.productCount} orthotics into {syncFetcher.data.finderSynced.lineCount} lines.
              </Text>
              {syncFetcher.data.finderSynced.skipped?.length > 0 && (
                <Text as="p" variant="bodySm">
                  Left out: {syncFetcher.data.finderSynced.skipped.map((x) => `${x.title} (${x.reason})`).join("; ")}
                </Text>
              )}
              <Text as="p" variant="bodySm" tone="subdued">Click Edit to see every line.</Text>
            </BlockStack>
          </Banner>
        )}

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
                    label="ID (what it recommends)"
                    helpText="One short word for what this recommends. For the Aetrex orthotic finder it must be: orthotic"
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
              </FormLayout>
              {editing.definition?.kind === "catalog_finder" ? (
                <FinderLines
                  definition={editing.definition}
                  onChange={(definition) => setEditing((p) => ({ ...p, definition }))}
                />
              ) : (
                <RecommenderTables
                  definition={editing.definition || {}}
                  onChange={(definition) => setEditing((p) => ({ ...p, definition }))}
                />
              )}
              <InlineStack>
                {editing.definition?.kind !== "catalog_finder" && <Button variant="plain" onClick={openAdvanced}>
                  {showMore ? "Hide more options" : "More options (spreadsheet, advanced)"}
                </Button>}
              </InlineStack>
              {showMore && (
                <BlockStack gap="400">
                  {editing.id && (
                    <MappingCsvSection
                      treeId={editing.id}
                      onApplied={(masterIndex) => setEditing((p) => ({
                        ...p,
                        definition: { ...p.definition, resolver: { ...(p.definition?.resolver || {}), masterIndex } },
                      }))}
                    />
                  )}
                  <BlockStack gap="200">
                    <Text as="h4" variant="headingSm">Advanced</Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Everything above plus rules like “flat arch means flat-foot control”. Edit only if you know the format; Apply copies it into the tables above.
                    </Text>
                    <TextField
                      label="Recommender definition"
                      labelHidden
                      value={jsonDraft}
                      onChange={setJsonDraft}
                      multiline={12}
                      monospaced
                      autoComplete="off"
                      error={jsonError || undefined}
                    />
                    <InlineStack>
                      <Button onClick={applyJson}>Apply</Button>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              )}
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

// The orthotic finder's lines, as read from the catalog (change the products
// in Shopify and sync). The store team chooses per line how the assistant
// recommends it: as usual, lead with it, only when the shopper mentions
// certain conditions, or never. Saved with the recommender.
const RULE_OPTIONS = [
  { label: "As usual", value: "normal" },
  { label: "Lead with this", value: "lead" },
  { label: "Only when they mention…", value: "only_when" },
  { label: "Never recommend", value: "never" },
];
function FinderLines({ definition, onChange }) {
  const lines = definition?.finder?.lines || [];
  const synced = definition?.syncedAt ? new Date(definition.syncedAt).toLocaleString() : "never";
  const rules = lineRulesOf(definition);
  // Typing "diabetes, neuropathy" keeps the text as typed until saved.
  const [whenText, setWhenText] = useState(() => Object.fromEntries(Object.entries(rules).filter(([, r]) => r.mode === "only_when").map(([id, r]) => [id, r.when.join(", ")])));
  const setRule = (id, rule) => {
    const next = { ...rules };
    if (!rule || rule.mode === "normal") delete next[id];
    else next[id] = rule;
    onChange({ ...definition, rules: next });
  };
  const versions = (l) => [
    l.archVersions.length === 2 ? "Medium-high & flat-low arch" : l.archVersions[0] === "flat_low" ? "Flat-low arch" : l.archVersions[0] === "medium_high" ? "Medium-high arch" : "One version",
    l.hasMetVersion && l.hasNoMetVersion ? "± met pad" : l.hasMetVersion ? "met pad" : "",
  ].filter(Boolean).join(", ");
  const recommendCell = (l) => {
    const r = rules[l.id] || { mode: "normal" };
    return (
      <BlockStack key={`r-${l.id}`} gap="100">
        <Select
          label={`How to recommend ${l.name}`}
          labelHidden
          options={RULE_OPTIONS}
          value={r.mode}
          onChange={(mode) => {
            if (mode === "only_when") {
              const text = whenText[l.id] || "";
              setRule(l.id, { mode, when: text.split(",").map((w) => w.trim()).filter(Boolean) });
            } else setRule(l.id, { mode });
          }}
        />
        {r.mode === "only_when" && (
          <TextField
            label={`Conditions for ${l.name}`}
            labelHidden
            placeholder="e.g. diabetes, neuropathy"
            value={whenText[l.id] ?? (r.when || []).join(", ")}
            onChange={(text) => {
              setWhenText((p) => ({ ...p, [l.id]: text }));
              setRule(l.id, { mode: "only_when", when: text.split(",").map((w) => w.trim()).filter(Boolean) });
            }}
            error={(r.when || []).length ? undefined : "Add at least one condition"}
            autoComplete="off"
          />
        )}
      </BlockStack>
    );
  };
  return (
    <BlockStack gap="200">
      <Text as="p" tone="subdued" variant="bodySm">
        {lines.length} lines from your catalog · last synced {synced}. To change one, edit the products in Shopify, then sync.
      </Text>
      <Text as="p" tone="subdued" variant="bodySm">
        <strong>Recommend</strong> sets how the assistant uses each line: <em>Lead with this</em> is its first choice when more than one line suits the shopper;
        <em> Only when they mention…</em> is offered only after the shopper brings up one of those conditions; <em>Never recommend</em> is never offered.
        Save to apply. Rules stay through syncs.
      </Text>
      <DataTable
        columnContentTypes={["text", "text", "text", "text", "numeric", "text"]}
        headings={["Line", "For", "Best for", "Versions", "Products", "Recommend"]}
        rows={lines.map((l) => [
          <Text key={l.id} as="span" fontWeight="semibold">{l.name}</Text>,
          l.genders.join(", "),
          l.bestFor || l.activity.join(", ") || "—",
          versions(l),
          l.count,
          recommendCell(l),
        ])}
      />
    </BlockStack>
  );
}

// CSV mapping editor — lets the merchant download the orthotic
// masterIndex as a spreadsheet, edit it in Excel/Sheets, and upload
// the result. The upload validates each row server-side, shows a diff
// summary, and only commits the change after the merchant confirms.
//
// Why this exists: the JSON textarea above is unfriendly for non-coders
// and is the actual source of bugs like "useCase=comfort → L200W
// (Diabetes-marketed product)" where the SEED MAPPING IS THE BUG, not
// the runtime. Fixing it via JSON requires care; via CSV requires a
// row edit.
function MappingCsvSection({ treeId, onApplied }) {
  const previewFetcher = useFetcher();
  const applyFetcher = useFetcher();
  const downloadFetcher = useFetcher();
  const fileInputRef = useRef(null);
  const [csvContent, setCsvContent] = useState("");
  const [fileName, setFileName] = useState("");
  const [downloadError, setDownloadError] = useState(null);

  // Download via fetch + blob URL. The earlier form-based approach
  // submitted to the same Remix route, but Remix intercepts the
  // navigation and treats the CSV Response as action data — which
  // closes the editor and never triggers a browser download. Using
  // fetch bypasses the router entirely; we get the raw Response and
  // turn it into a download via blob URL + synthetic <a download>.
  const handleDownload = () => {
    setDownloadError(null);
    const fd = new FormData();
    fd.set("intent", "export_mapping_csv");
    fd.set("id", treeId);
    // useFetcher (vs raw fetch) carries the App Bridge session token
    // automatically — raw fetch from the embedded admin iframe was
    // hitting the OAuth redirect and downloading the React app HTML
    // instead of the CSV.
    downloadFetcher.submit(fd, { method: "post" });
  };

  // Watch for the action's response and trigger a client-side download
  // once the CSV string arrives.
  useEffect(() => {
    if (downloadFetcher.state !== "idle") return;
    const data = downloadFetcher.data;
    if (!data) return;
    if (data.error) {
      setDownloadError(data.error);
      return;
    }
    const exp = data.mappingCsvExport;
    if (!exp || !exp.csv) return;
    setDownloadError(null);
    const blob = new Blob([exp.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exp.filename || `mapping-${treeId.slice(0, 8)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [downloadFetcher.state, downloadFetcher.data, treeId]);
  const downloading = downloadFetcher.state !== "idle";

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const text = await file.text();
    setCsvContent(text);
  };

  const triggerFilePicker = () => {
    fileInputRef.current?.click();
  };

  const clearUpload = () => {
    setCsvContent("");
    setFileName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const submitPreview = () => {
    const fd = new FormData();
    fd.set("intent", "preview_upload_mapping_csv");
    fd.set("id", treeId);
    fd.set("csv", csvContent);
    previewFetcher.submit(fd, { method: "post" });
  };

  const submitApply = () => {
    const fd = new FormData();
    fd.set("intent", "apply_upload_mapping_csv");
    fd.set("id", treeId);
    fd.set("csv", csvContent);
    applyFetcher.submit(fd, { method: "post" });
  };

  const preview = previewFetcher.data?.mappingCsvPreview;
  const applied = applyFetcher.data?.mappingCsvApplied;
  // The upload is saved directly — copy it into the open editor so a later
  // Save doesn't put the old rows back.
  useEffect(() => {
    if (applied && Array.isArray(applyFetcher.data.masterIndex)) onApplied?.(applyFetcher.data.masterIndex);
    // Once per upload response; onApplied is a new function every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyFetcher.data]);
  const applyError = applyFetcher.data?.error;

  return (
    <Box
      paddingBlockStart="400"
      paddingBlockEnd="400"
    >
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h4" variant="headingMd">
            Edit mapping as a spreadsheet (CSV)
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Download the SKU mapping as a CSV file, edit it in Excel or Google Sheets,
            and upload it back. Only the SKU rows change — chip questions and other
            tree settings stay the same.
          </Text>
        </BlockStack>

        {/* Hidden file input — triggered by the styled Polaris Button below. */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={handleFileChange}
          style={{ display: "none" }}
          aria-hidden="true"
          tabIndex={-1}
        />

        <InlineStack gap="200" wrap>
          <Button
            onClick={handleDownload}
            loading={downloading}
            disabled={downloading}
            variant="secondary"
          >
            Download CSV
          </Button>
          <Button onClick={triggerFilePicker} variant="secondary">
            {fileName ? `Replace: ${fileName.length > 24 ? fileName.slice(0, 24) + "…" : fileName}` : "Upload CSV"}
          </Button>
          {csvContent && (
            <>
              <Button
                onClick={submitPreview}
                disabled={previewFetcher.state === "submitting"}
                loading={previewFetcher.state === "submitting"}
                variant="primary"
              >
                Preview changes
              </Button>
              <Button onClick={clearUpload} variant="plain">
                Clear
              </Button>
            </>
          )}
        </InlineStack>

        {fileName && !preview && !applied && (
          <Text as="p" variant="bodySm" tone="subdued">
            Loaded: {fileName} ({csvContent.length.toLocaleString()} characters). Click <strong>Preview changes</strong> to see the diff.
          </Text>
        )}

        {downloadError && (
          <Banner tone="critical" title="Download failed">
            <Text as="p" variant="bodySm">{downloadError}</Text>
          </Banner>
        )}

        {/* Preview result */}
        {preview && !preview.ok && (
          <Banner tone="critical" title="CSV validation failed">
            <BlockStack gap="100">
              {preview.errors.map((e, i) => (
                <Text key={i} as="p" variant="bodySm">
                  • {e}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        )}

        {preview && preview.ok && !applied && (
          <Banner
            tone={preview.diff.added + preview.diff.removed + preview.diff.modified > 0 ? "info" : "success"}
            title={`Preview: ${preview.rowCount} rows total`}
          >
            <BlockStack gap="200">
              <Text as="p" variant="bodySm">
                <strong>+{preview.diff.added}</strong> added,{" "}
                <strong>-{preview.diff.removed}</strong> removed,{" "}
                <strong>~{preview.diff.modified}</strong> modified
              </Text>
              {preview.diff.addedSample.length > 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Added (sample): {preview.diff.addedSample.join(", ")}
                </Text>
              )}
              {preview.diff.removedSample.length > 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Removed (sample): {preview.diff.removedSample.join(", ")}
                </Text>
              )}
              {preview.diff.modifiedSample.length > 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Modified (sample): {preview.diff.modifiedSample
                    .map((m) => `${m.masterSku} (${Object.keys(m.changes).join(", ")})`)
                    .join("; ")}
                </Text>
              )}
              <InlineStack gap="200">
                <Button
                  onClick={submitApply}
                  variant="primary"
                  loading={applyFetcher.state === "submitting"}
                >
                  Apply changes
                </Button>
                <Button onClick={() => { setCsvContent(""); setFileName(""); }}>
                  Cancel
                </Button>
              </InlineStack>
            </BlockStack>
          </Banner>
        )}

        {applied && (
          <Banner tone="success" title="Mapping updated">
            <Text as="p" variant="bodySm">
              {applyFetcher.data.rowCount} rows applied. Your chat will use the new mapping
              on the next conversation. Reload this page to see the updated JSON.
            </Text>
          </Banner>
        )}

        {applyError && (
          <Banner tone="critical" title="Apply failed">
            <Text as="p" variant="bodySm">{applyError}</Text>
          </Banner>
        )}
      </BlockStack>
    </Box>
  );
}

// Fit confidence: the bar on every shoe and orthotic card in the chat, and
// what its scores were read from. The page checks again every few seconds
// while a read is under way.
const fmtCount = (n) => Number(n || 0).toLocaleString("en-US");
const fmtWhen = (iso) => {
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
};
const FIT_STEPS = { products: "Reading products…", sales: "Reading sales and returns…", reviews: "Reading reviews", returns: "Reading return reasons", scores: "Scoring styles…" };

function FitSource({ title, state, ok }) {
  return (
    <InlineStack gap="300" blockAlign="start" wrap={false}>
      <Box minWidth="150px"><Text as="span" variant="bodyMd" fontWeight="semibold">{title}</Text></Box>
      <Text as="span" tone={ok === false ? "critical" : ok ? undefined : "subdued"}>{state}</Text>
    </InlineStack>
  );
}

function FitConfidenceCard({ fit }) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [isOn, setIsOn] = useState(!!fit.enabled);
  const running = Boolean(fit.run?.running) || (fetcher.state !== "idle" && fetcher.formData?.get("intent") === "refresh_fit_confidence");
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  useEffect(() => {
    if (!fit.run?.running) return undefined;
    const t = setInterval(() => { if (revalidatorRef.current.state === "idle") revalidatorRef.current.revalidate(); }, 4000);
    return () => clearInterval(t);
  }, [fit.run?.running]);

  const toggle = (checked) => {
    setIsOn(checked);
    const fd = new FormData();
    fd.set("intent", "toggle_fit_confidence");
    fd.set("fitConfidenceEnabled", String(checked));
    fetcher.submit(fd, { method: "post" });
  };
  const readNow = () => {
    const fd = new FormData();
    fd.set("intent", "refresh_fit_confidence");
    fetcher.submit(fd, { method: "post" });
  };

  const st = fit.status || {};
  const reviews = st.reviews?.ok
    ? `${fmtCount(st.reviews.answered)} fit answers in ${fmtCount(st.reviews.reviews)} reviews · ${fmtCount(st.reviews.styles)} styles`
    : st.reviews?.error || (fit.hasYotpo ? "Not read yet." : "Add the Yotpo app key in Settings → Integrations.");
  const sales = st.sales?.ok
    ? `${fmtCount(st.sales.sold)} pairs sold, ${fmtCount(st.sales.returned)} returned (last 12 months)`
    : st.sales?.error || "Not read yet.";
  const returns = st.returns?.ok
    ? `${fmtCount(st.returns.items)} returned items read · ${st.returns.items ? Math.round((st.returns.fit / st.returns.items) * 100) : 0}% for size or fit`
    : st.returns?.error || (fit.hasAftership ? "Not read yet." : "Add the AfterShip API key in Settings → Integrations.");
  const step = FIT_STEPS[fit.run?.step] || "Reading…";
  const progress = fit.run?.total > 0 ? ` ${fmtCount(Math.min(fit.run.done, fit.run.total))} of ${fmtCount(fit.run.total)}${fit.run.step === "reviews" ? " styles" : fit.run.step === "returns" ? " weeks" : ""}` : "";

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Fit confidence</Text>
            <Badge tone={isOn ? "success" : undefined}>{isOn ? "On" : "Off"}</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            A small meter on every shoe and orthotic card in the chat — &quot;Fit ━━━ 92%&quot;, with &quot;Runs small&quot; (or large, narrow, wide) under it when that&apos;s what buyers found — that says how sure a shopper can be the style fits as expected. It&apos;s read from reviewers&apos; own fit answers (Yotpo), the pairs sold and sent back in the last 12 months (Shopify) and why they came back (AfterShip), across all of a style&apos;s colors. A style with too little to go on shows no bar. It never names a size — True Fit does that.
          </Text>
          <Text as="p" tone="subdued">
            {fit.vip
              ? "Signed-in shoppers see it for the size they've kept before, from their own past orders."
              : "With VIP mode on (Settings → Integrations), signed-in shoppers see it for the size they've kept before."}
          </Text>
        </BlockStack>

        <Checkbox label="Show fit confidence on product cards" checked={isOn} onChange={toggle} />

        <Divider />
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">What it&apos;s read from</Text>
          <FitSource title="Reviews (Yotpo)" state={reviews} ok={st.reviews ? st.reviews.ok : null} />
          <FitSource title="Sales (Shopify)" state={sales} ok={st.sales ? st.sales.ok : null} />
          <FitSource title="Return reasons (AfterShip)" state={returns} ok={st.returns ? st.returns.ok : null} />
        </BlockStack>

        <InlineStack align="space-between" blockAlign="center" gap="300">
          <Text as="span" tone="subdued">
            {running
              ? `${step}${progress}`
              : fit.readAt
                ? `Read ${fmtWhen(fit.readAt)} · ${fmtCount(fit.scored)} ${fit.scored === 1 ? "style has" : "styles have"} a score · read again every day`
                : "Not read yet."}
          </Text>
          <Button onClick={readNow} loading={running} disabled={running}>Read now</Button>
        </InlineStack>

        {fit.lowest?.length > 0 && (
          <>
            <Divider />
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Lowest fit confidence</Text>
              <DataTable
                columnContentTypes={["text", "numeric", "text", "numeric", "numeric"]}
                headings={["Style", "Fit", "How it fits", "Reviews", "Pairs sold"]}
                rows={fit.lowest.map((x) => [
                  [x.name, x.line].filter(Boolean).join(" · "),
                  `${x.s}%`,
                  FIT_LABELS[x.l] || "—",
                  fmtCount(x.r),
                  fmtCount(x.n),
                ])}
              />
            </BlockStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

// Fit predictor lives on this page now — it's the other "guided answer"
// surface (size recommendation instead of product recommendation), so
// merchants manage both recommenders in one place. The form-data shape and
// config storage are unchanged from the old standalone /app/fit-predictor
// page, which now redirects here.
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
  const [externalAuth, setExternalAuth] = useState("");

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
            <Badge tone="info">Beta</Badge>
            <Badge tone={isOn ? "success" : undefined}>{isOn ? "Enabled" : "Disabled"}</Badge>
          </InlineStack>
          <Text as="p" tone="subdued">
            Shows a visual size recommendation with a confidence score when a customer asks "what size should I get?". Combines review fit data (Yotpo), return sizing reasons (Aftership), the logged-in customer's own order history, and an optional external fit API into one card under the product.
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
                  placeholder={config?.externalAuthHeaderSet ? "Saved — leave blank to keep it" : "Authorization: Bearer xxxx"}
                  autoComplete="off"
                  helpText="Format: Header-Name: value. Clearing the endpoint removes it."
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

export default function SmartRecommenders() {
  const data = useLoaderData();
  return (
    <Page>
      <TitleBar title="Smart Recommenders" />
      <BrandHeader title="Smart Recommenders" />
      <BlockStack gap="800">
        <BlockStack gap="400">
          <SectionHeading
            eyebrow="Smart Recommenders"
            title="Guided product finders"
            description="A short Q&A that returns one specific product. The customer answers a few choice-button questions and gets exactly one master SKU back — same answers in, same SKU out. Off by default."
          />
          <HowItWorksCard />
          <DecisionTreesCard
            enabled={data.decisionTreeEnabled}
            trees={data.decisionTrees}
          />
        </BlockStack>

        <BlockStack gap="400">
          <SectionHeading
            eyebrow="Fit Confidence"
            title="Fit on every product card"
            description="How sure a shopper can be that a style fits as expected, on every shoe and orthotic card in the chat — from reviews, sales, returns and why they came back."
          />
          <FitConfidenceCard fit={data.fitConfidence} />
        </BlockStack>

        <BlockStack gap="400">
          <SectionHeading
            eyebrow="Fit Predictor"
            title="Size recommendations"
            description="The other guided answer: when a customer asks what size to get, the AI can show a visual size recommendation with a confidence score, built from reviews, returns, and order history."
          />
          <PlanGate
            plan={data.plan}
            feature="fitPredictor"
            summary="Visual fit-confidence card with size recommendation, aggregating reviews, return reasons, customer order history, and any merchant-configured external fit API."
          >
            <FitPredictorCard enabled={data.fitPredictorEnabled} config={data.fitPredictorConfig} />
          </PlanGate>
        </BlockStack>
      </BlockStack>
    </Page>
  );
}
