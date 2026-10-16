import prisma from "../db.server.js";

// CRUD for DecisionTree rows. Pure data layer — does NOT validate
// the shape of `definition`. Validation lives in
// app/lib/decision-tree-schema.server.js (Batch 2) so save-time and
// runtime checks share one source of truth.
//
// Multi-tree per shop: a merchant can have N DecisionTree rows, each
// keyed by a unique `intent` slug. Aetrex's first instance is
// intent="orthotic"; future instances might be "footwear",
// "athletic_shoe", etc. The chat layer activates at most one tree
// per turn based on category-intent detection.

export async function listDecisionTrees(shop) {
  if (!shop) return [];
  return prisma.decisionTree.findMany({
    where: { shop },
    orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      intent: true,
      triggerPhrases: true,
      triggerCategoryGroup: true,
      enabled: true,
      startedCount: true,
      completedCount: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

// Fetch including the full `definition`. Use this from runtime paths
// (chat.jsx) — listDecisionTrees omits `definition` because the admin
// list view doesn't need it and it can be large.
export async function getDecisionTreeById(shop, id) {
  if (!shop || !id) return null;
  return prisma.decisionTree.findFirst({ where: { shop, id } });
}

// The intent field's help text used to start with "a-z, 0-9, _, -", and
// merchants typed exactly that — leaving the orthotic finder invisible to
// the chat (which looks for intent "orthotic"). A placeholder-looking intent
// on a tree that is clearly the orthotic finder is repaired to "orthotic".
const PLACEHOLDER_INTENT_RE = /^(?:a-z|a-z0-9|az|az09|intent|slug|tbd|test|x+)(?:[-_].*)?$/;

export function isPlaceholderIntent(intent) {
  return PLACEHOLDER_INTENT_RE.test(String(intent || "").trim().toLowerCase());
}

export function looksLikeOrthoticTree(tree) {
  const hay = [tree?.name, tree?.triggerCategoryGroup, tree?.triggerPhrases].map((v) => String(v || "")).join(" ");
  return /orthotic|insole/i.test(hay);
}

export async function repairOrthoticIntent(shop) {
  if (!shop) return null;
  const trees = await prisma.decisionTree.findMany({ where: { shop }, select: { id: true, name: true, intent: true, triggerPhrases: true, triggerCategoryGroup: true } });
  if (trees.some((t) => t.intent === "orthotic")) return null;
  const candidates = trees.filter((t) => looksLikeOrthoticTree(t) && (isPlaceholderIntent(t.intent) || !t.intent));
  if (candidates.length !== 1) return null;
  const fixed = await prisma.decisionTree.update({ where: { id: candidates[0].id }, data: { intent: "orthotic" } });
  console.log(`[decision-tree] ${shop}: repaired intent "${candidates[0].intent}" → "orthotic" on "${candidates[0].name}"`);
  return fixed;
}

export async function getDecisionTreeByIntent(shop, intent) {
  if (!shop || !intent) return null;
  const found = await prisma.decisionTree.findUnique({ where: { shop_intent: { shop, intent } } });
  if (found || intent !== "orthotic") return found;
  return repairOrthoticIntent(shop).catch(() => null);
}

// Returns enabled trees only. Hot path: called per-turn from
// chat.jsx when ShopConfig.decisionTreeEnabled is true. Keep the
// shape narrow — the engine reads the full `definition` and trigger
// fields; nothing else is needed.
export async function getEnabledDecisionTrees(shop) {
  if (!shop) return [];
  const trees = await loadEnabledTrees(shop);
  if (trees.some((t) => t.intent !== "orthotic" && isPlaceholderIntent(t.intent) && looksLikeOrthoticTree(t))) {
    if (await repairOrthoticIntent(shop).catch(() => null)) return loadEnabledTrees(shop);
  }
  return trees;
}

function loadEnabledTrees(shop) {
  return prisma.decisionTree.findMany({
    where: { shop, enabled: true },
    select: {
      id: true,
      name: true,
      intent: true,
      triggerPhrases: true,
      triggerCategoryGroup: true,
      definition: true,
    },
  });
}

// Caller-supplied fields are validated at the route layer; we only
// enforce required keys + length caps here so the DB never gets
// degenerate rows. `definition` is JSON — pass an object, Prisma
// serializes it to JSONB.
export async function saveDecisionTree(shop, { id, name, intent, triggerPhrases, triggerCategoryGroup, definition, enabled }) {
  if (!shop) throw new Error("shop required");
  const data = {
    name: String(name || "").trim().slice(0, 200),
    intent: String(intent || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 50),
    triggerPhrases: typeof triggerPhrases === "string" ? triggerPhrases : JSON.stringify(triggerPhrases || []),
    triggerCategoryGroup: triggerCategoryGroup ? String(triggerCategoryGroup).trim().slice(0, 100) : null,
    definition: definition ?? {},
    enabled: Boolean(enabled),
  };
  if (!data.name) throw new Error("name required");
  if (isPlaceholderIntent(data.intent) && looksLikeOrthoticTree(data)) data.intent = "orthotic";
  if (!data.intent || isPlaceholderIntent(data.intent)) {
    throw new Error(`"${data.intent || ""}" isn't a usable ID. Use a short word for what it recommends — for the orthotic finder, use: orthotic`);
  }

  if (id) {
    return prisma.decisionTree.update({ where: { id }, data });
  }
  return prisma.decisionTree.create({ data: { ...data, shop } });
}

export async function deleteDecisionTree(shop, id) {
  if (!shop || !id) return;
  await prisma.decisionTree.deleteMany({ where: { id, shop } });
}

// Atomic counter bumps. Called from the chat layer when a tree
// session starts (first question shown) and again when it completes
// (resolver returns a SKU). Failures are swallowed — analytics
// counters must never break a customer turn.
export async function incrementStartedCount(shop, id) {
  if (!shop || !id) return;
  try {
    await prisma.decisionTree.update({
      where: { id },
      data: { startedCount: { increment: 1 } },
    });
  } catch {
    /* ignore */
  }
}

export async function incrementCompletedCount(shop, id) {
  if (!shop || !id) return;
  try {
    await prisma.decisionTree.update({
      where: { id },
      data: { completedCount: { increment: 1 } },
    });
  } catch {
    /* ignore */
  }
}
