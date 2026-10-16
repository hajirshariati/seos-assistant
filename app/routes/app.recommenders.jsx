import { useEffect, useRef, useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
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
  getDecisionTreeByIntent,
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
import {
  fetchActiveOrthoticProducts,
  discoverDistinctValues,
  buildSuggestedMapping,
  regenerateMasterIndex,
} from "../lib/regenerate-orthotic.server";
import prisma from "../db.server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import BrandHeader from "../components/BrandHeader";
import { getShopPlan } from "../lib/billing.server";
import { PlanGate } from "../components/PlanGate";

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
  return {
    shop: session.shop,
    decisionTreeEnabled: config.decisionTreeEnabled === true,
    decisionTrees: decisionTrees.map((t) => ({
      ...t,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
      updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : t.updatedAt,
    })),
    fitPredictorEnabled: config.fitPredictorEnabled === true,
    fitPredictorConfig: (() => {
      try {
        const v = JSON.parse(config.fitPredictorConfig || "{}");
        return v && typeof v === "object" ? v : {};
      } catch {
        return {};
      }
    })(),
    plan: { id: plan.id, name: plan.name, features: plan.features },
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
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

  // Discover what's in the live Shopify catalog so the merchant can
  // see distinct activity / helps_with metafield values BEFORE the
  // regen runs. Used the first time and any time new metafield values
  // appear that the saved mapping doesn't cover.
  if (intent === "regen_orthotic_discover") {
    try {
      const accessToken = await getOfflineToken(session.shop);
      if (!accessToken) return { error: "No offline session for this shop. Re-install the app to refresh the token." };
      const products = await fetchActiveOrthoticProducts({ shop: session.shop, accessToken });
      const distinct = discoverDistinctValues(products);
      const existing = await getDecisionTreeByIntent(session.shop, "orthotic");
      const savedMapping = existing?.definition?.vocabularyMapping || null;
      const suggestedMapping = buildSuggestedMapping(distinct);
      // If a saved mapping already exists, surface only the NEW values
      // (the ones the merchant hasn't mapped yet) so they aren't asked
      // to re-confirm everything they already approved.
      const newActivity = savedMapping?.activity
        ? distinct.distinctActivity.filter((v) => !(v in savedMapping.activity))
        : distinct.distinctActivity;
      const newHelpsWith = savedMapping?.helps_with
        ? distinct.distinctHelpsWith.filter((v) => !(v in savedMapping.helps_with))
        : distinct.distinctHelpsWith;
      return {
        discovery: {
          productCount: products.length,
          distinctActivity: distinct.distinctActivity,
          distinctHelpsWith: distinct.distinctHelpsWith,
          distinctGender: distinct.distinctGender,
          newActivity,
          newHelpsWith,
          suggestedMapping,
          savedMapping,
        },
      };
    } catch (err) {
      return { error: "Discovery failed: " + (err?.message || "unknown") };
    }
  }

  // Apply the merchant-reviewed mapping, regenerate the masterIndex
  // straight from live Shopify, and write it to the orthotic
  // DecisionTree row. The mapping is persisted inside
  // definition.vocabularyMapping so future regens reuse it.
  if (intent === "regen_orthotic_apply") {
    try {
      const accessToken = await getOfflineToken(session.shop);
      if (!accessToken) return { error: "No offline session for this shop." };
      let mapping;
      try {
        mapping = JSON.parse(formData.get("mapping") || "{}");
      } catch {
        return { error: "Invalid mapping JSON." };
      }
      const products = await fetchActiveOrthoticProducts({ shop: session.shop, accessToken });
      const result = regenerateMasterIndex({ products, mapping });

      const existing = await getDecisionTreeByIntent(session.shop, "orthotic");
      if (!existing) {
        return { error: "No orthotic recommender exists yet. Click 'Reset to factory' first to install the base structure." };
      }
      const oldDef = existing.definition || {};
      const newDef = {
        ...oldDef,
        resolver: {
          ...(oldDef.resolver || {}),
          masterIndex: result.masterIndex,
          fallback: result.fallback,
        },
        vocabularyMapping: mapping,
        _lastRegenAt: new Date().toISOString(),
        _lastRegenSource: "shopify-live",
      };
      const v = validateDecisionTree(newDef);
      if (!v.ok) return { error: "Generated tree is invalid: " + v.errors.slice(0, 4).join("; ") };
      await saveDecisionTree(session.shop, {
        id: existing.id,
        name: existing.name,
        intent: existing.intent,
        triggerPhrases: existing.triggerPhrases,
        triggerCategoryGroup: existing.triggerCategoryGroup,
        definition: newDef,
        enabled: existing.enabled,
      });
      return {
        regenerated: {
          productCount: products.length,
          masterIndexCount: result.masterIndex.length,
          skippedCount: result.skipped.length,
          skipped: result.skipped,
          fallback: result.fallback,
          unmappedActivity: result.unmappedActivity,
          unmappedHelpsWith: result.unmappedHelpsWith,
        },
      };
    } catch (err) {
      return { error: "Regeneration failed: " + (err?.message || "unknown") };
    }
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

  return { error: "Unknown action" };
};

// Look up the most recent offline access token for a shop. The same
// pattern the chat layer uses — every Shopify-side call goes through
// the offline session so the token survives admin sign-out/in cycles.
async function getOfflineToken(shop) {
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false, accessToken: { not: "" } },
    orderBy: { expires: "desc" },
  });
  return session?.accessToken || null;
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
            <strong>Short Q&amp;A, fixed answers.</strong> A few choice-button
            questions with the exact labels you saved — the AI doesn't paraphrase,
            so the same click always maps to the same product.
          </Bullet>
          <Bullet>
            <strong>Three ways to answer.</strong> Click a button, type freely
            (keyword-matched), or fall back to a tight AI call that picks one of
            your defined options.
          </Bullet>
          <Bullet>
            <strong>Memory across turns.</strong> Answers accumulate. Already-
            answered questions are skipped. Customers can pivot mid-flow.
          </Bullet>
          <Bullet>
            <strong>One deterministic SKU at the end.</strong> Filtered against
            your live Shopify catalog so nothing is hallucinated.
          </Bullet>
          <Bullet>
            <strong>Built-in guardrails.</strong> Respects footwear pivots,
            explicit rejections, off-topic questions (shipping, returns), and
            impossible matches (e.g. orthotic for open sandals → suggests
            supportive sandals instead). Kids never fall back to adult SKUs.
          </Bullet>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function DecisionTreesCard({ enabled, trees }) {
  const fetcher = useFetcher();
  const loadFetcher = useFetcher();
  const regenFetcher = useFetcher();
  const [editing, setEditing] = useState(null);  // { id?, name, intent, ... }
  const [showCreate, setShowCreate] = useState(false);
  // Regenerate-from-Shopify modal state. When discovery returns
  // unmapped values (or this is the first run), show the merchant
  // the suggested mapping in a textarea so they can review/tweak
  // before applying. Saved mappings hide the textarea by default.
  const [regenStep, setRegenStep] = useState("idle"); // idle | review | done
  const [mappingDraft, setMappingDraft] = useState("");

  useEffect(() => {
    if (regenFetcher.data?.discovery) {
      const d = regenFetcher.data.discovery;
      const merged = d.savedMapping
        ? {
            ...d.savedMapping,
            activity: { ...d.suggestedMapping.activity, ...d.savedMapping.activity },
            helps_with: { ...d.suggestedMapping.helps_with, ...d.savedMapping.helps_with },
            gender: { ...d.suggestedMapping.gender, ...d.savedMapping.gender },
            specialtyOverrides: d.savedMapping.specialtyOverrides || d.suggestedMapping.specialtyOverrides,
          }
        : d.suggestedMapping;
      setMappingDraft(JSON.stringify(merged, null, 2));
      setRegenStep("review");
    }
    if (regenFetcher.data?.regenerated) {
      setRegenStep("done");
    }
  }, [regenFetcher.data]);

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

  const startRegen = () => {
    setRegenStep("discovering");
    const fd = new FormData();
    fd.set("intent", "regen_orthotic_discover");
    regenFetcher.submit(fd, { method: "post" });
  };

  const applyRegen = () => {
    const fd = new FormData();
    fd.set("intent", "regen_orthotic_apply");
    fd.set("mapping", mappingDraft);
    regenFetcher.submit(fd, { method: "post" });
  };

  const closeRegen = () => {
    setRegenStep("idle");
    setMappingDraft("");
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
            <Text as="h3" variant="headingMd">Manage recommenders</Text>
            <Checkbox
              label={enabled ? "Recommenders ON" : "Recommenders OFF"}
              checked={enabled}
              disabled={masterToggleSubmitting}
              onChange={(next) => toggleMaster(next)}
            />
          </InlineStack>
          <Text as="p" tone="subdued">
            A recommender is a short guided quiz. When a shopper asks for help
            picking an orthotic, the assistant asks a few tap-to-answer
            questions (who it's for, what shoes, what hurts, arch type) and
            shows the one orthotic that fits. Setup: click <strong>Reset to
            factory</strong> once, then <strong>Sync from Shopify</strong>,
            and switch this ON. Turned OFF, the assistant still recommends
            orthotics — just without the quiz.
          </Text>
        </BlockStack>

        {fetcher.data?.error && (
          <Banner tone="critical">{fetcher.data.error}</Banner>
        )}
        {fetcher.data?.seeded && (
          <Banner tone="success">Factory data installed. Review the recommender below, then enable it.</Banner>
        )}

        <Divider />

        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text as="h4" variant="headingSm">Your recommenders</Text>
            <InlineStack gap="200" wrap>
              <Button onClick={startNew}>+ New recommender</Button>
              <Button
                onClick={startRegen}
                variant="primary"
                loading={regenFetcher.state !== "idle" && regenStep === "discovering"}
              >
                Sync from Shopify
              </Button>
              <Button onClick={seedAetrex} variant="tertiary">
                Reset to factory
              </Button>
            </InlineStack>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            <strong>Sync from Shopify</strong> rebuilds the lookup table from your
            live products' metafields — run this whenever you add, remove, or
            retag orthotic products. <strong>Reset to factory</strong> reinstalls
            Aetrex's bundled 183-SKU starting point — only needed for first
            install or to discard customizations and start over.
          </Text>

          {(!trees || trees.length === 0) && (
            <Text as="p" tone="subdued">
              No recommenders yet. Click <strong>Reset to factory</strong> to
              install the bundled Aetrex orthotic lookup (183 SKUs), or build
              your own from scratch.
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

        {regenFetcher.data?.error && (
          <Banner tone="critical">{regenFetcher.data.error}</Banner>
        )}

        {regenStep === "review" && regenFetcher.data?.discovery && (
          <>
            <Divider />
            <BlockStack gap="300">
              <Text as="h4" variant="headingSm">Review mapping (Step 2 of 2)</Text>
              <Text as="p" tone="subdued">
                Pulled <strong>{regenFetcher.data.discovery.productCount}</strong> active orthotic products from Shopify.
                Found {regenFetcher.data.discovery.distinctActivity.length} activity values, {regenFetcher.data.discovery.distinctHelpsWith.length} helps_with values, and {regenFetcher.data.discovery.distinctGender.length} gender values.
              </Text>
              {(regenFetcher.data.discovery.newActivity?.length > 0 ||
                regenFetcher.data.discovery.newHelpsWith?.length > 0) && (
                <Banner tone="info">
                  New metafield values found that weren't in your saved mapping. They've been merged with sensible-guess defaults below — review before applying.
                  {regenFetcher.data.discovery.newActivity?.length > 0 && (
                    <Text as="p" variant="bodySm">New activity: {regenFetcher.data.discovery.newActivity.join(", ")}</Text>
                  )}
                  {regenFetcher.data.discovery.newHelpsWith?.length > 0 && (
                    <Text as="p" variant="bodySm">New helps_with: {regenFetcher.data.discovery.newHelpsWith.join(", ")}</Text>
                  )}
                </Banner>
              )}
              <TextField
                label="Mapping (edit any guess that's wrong, then Apply)"
                helpText="The mapping is saved with the recommender so future regenerations reuse it. Only edit values you know are wrong."
                value={mappingDraft}
                onChange={(v) => setMappingDraft(v)}
                multiline={20}
                autoComplete="off"
              />
              <InlineStack gap="200" align="end">
                <Button onClick={closeRegen}>Cancel</Button>
                <Button
                  onClick={applyRegen}
                  variant="primary"
                  loading={regenFetcher.state !== "idle" && regenStep === "review"}
                >
                  Apply mapping & regenerate
                </Button>
              </InlineStack>
            </BlockStack>
          </>
        )}

        {regenStep === "done" && regenFetcher.data?.regenerated && (
          <>
            <Divider />
            <Banner tone="success">
              <BlockStack gap="200">
                <Text as="p" fontWeight="semibold">
                  Regenerated {regenFetcher.data.regenerated.masterIndexCount} entries from {regenFetcher.data.regenerated.productCount} active Shopify products.
                </Text>
                {regenFetcher.data.regenerated.fallback && (
                  <Text as="p" variant="bodySm">
                    Fallback: <code>{regenFetcher.data.regenerated.fallback.masterSku}</code> — {regenFetcher.data.regenerated.fallback.title}
                  </Text>
                )}
                {regenFetcher.data.regenerated.skippedCount > 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {regenFetcher.data.regenerated.skippedCount} product{regenFetcher.data.regenerated.skippedCount === 1 ? "" : "s"} skipped — usually missing gender or activity metafield. Open the tree to review.
                  </Text>
                )}
                <InlineStack>
                  <Button onClick={closeRegen}>Close</Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </>
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
              {/* CSV editor first — most merchants will use this and never touch the raw JSON. */}
              {editing.id && (
                <MappingCsvSection treeId={editing.id} />
              )}
              <FormLayout>
                <Box paddingBlockStart="200">
                  <Text as="h4" variant="headingSm">Advanced — raw JSON</Text>
                </Box>
                <div
                  style={{
                    maxHeight: "320px",
                    overflowY: "auto",
                    border: "1px solid var(--p-color-border, #e1e3e5)",
                    borderRadius: "8px",
                    padding: "0",
                  }}
                >
                  <TextField
                    label="Lookup table (JSON)"
                    labelHidden
                    value={editing.definition}
                    onChange={onChange("definition")}
                    multiline={12}
                    monospaced
                    autoComplete="off"
                    helpText="The resolver.masterIndex array drives the recommendation: each entry maps an attribute set (gender, useCase, condition, etc.) to a master SKU. For most edits use the CSV editor above. The JSON view is here for chip questions, derivations, and other advanced fields."
                  />
                </div>
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
function MappingCsvSection({ treeId }) {
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
