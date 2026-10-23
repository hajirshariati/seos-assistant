import { resolveTree } from "./decision-tree-resolver.server.js";
import { validateDecisionTree } from "./decision-tree-schema.server.js";
// Runtime-only use (called inside executeRecommenderTool, never at module
// load) so the orthotic-flow-gate ⇄ recommender-tools import cycle is safe —
// hoisted function export, resolved by the time the tool runs.
import { orthoticChipLabelsForAttribute } from "./recommender-chips.server.js";
import { conditionFromText } from "./condition-normalize.js";

// Apply tree-level derivations to the customer's answer set BEFORE
// resolving. Derivations let merchants encode rules like "if
// condition is metatarsalgia, set metSupport=true" or "if
// arch=Flat OR overpronation=yes, set posted=true". These were
// part of the original engine; the refactor moved resolution into
// a tool but the derivations slipped through the cracks. Without
// this, the resolver sees only what the LLM passed in and can't
// honor the merchant's clinical mappings, so e.g. ball-of-foot
// pain returns the no-met SKU instead of the W/ Met Support twin.
//
// Pure function. The when-clause grammar (any / all / eq / in)
// matches the original engine's evalCondition for backward compat
// with tree definitions authored under the funnel-era schema.
function evalDerivationCondition(cond, answers) {
  if (!cond) return false;
  if (Array.isArray(cond.any)) return cond.any.some((c) => evalDerivationCondition(c, answers));
  if (Array.isArray(cond.all)) return cond.all.every((c) => evalDerivationCondition(c, answers));
  if (cond.attr && "eq" in cond) return answers[cond.attr] === cond.eq;
  if (cond.attr && Array.isArray(cond.in)) return cond.in.includes(answers[cond.attr]);
  return false;
}
function applyDerivations(answers, derivations) {
  if (!Array.isArray(derivations) || derivations.length === 0) return answers || {};
  const out = { ...(answers || {}) };
  for (const rule of derivations) {
    if (!rule || !rule.set || rule.value === undefined || !rule.when) continue;
    if (evalDerivationCondition(rule.when, out)) {
      out[rule.set] = rule.value;
    }
  }
  return out;
}

// The orthotic classifier and the recommend_<intent> tool schema emit a
// COARSE useCase vocabulary (athletic_training, athletic_general, cleats,
// work_all_day, casual, comfort, dress, …) that predates the granular
// per-merchant tree values (athletic_training_gym, athletic_training_sports,
// boots_construction, comfort_walking_everyday, dress_no_removable, …).
// Nothing else bridges them, so a coarse value silently hard-filters the
// resolver to zero candidates → neutral fallback. Each alias maps a coarse
// value to the granular target(s) it could mean; it is applied ONLY when the
// target EXISTS in this tree and the coarse source does NOT — so a merchant
// still on the old vocabulary is never touched. (cleats folds into the
// merchant's combined sports bucket when no dedicated cleats SKU exists.)
const USE_CASE_ALIASES = {
  athletic_training: ["athletic_training_gym"],
  athletic_general: ["athletic_training_sports"],
  cleats: ["athletic_training_sports"],
  work_all_day: ["boots_construction"],
  casual: ["comfort_walking_everyday"],
  comfort: ["comfort_walking_everyday"],
  dress: ["dress_no_removable"],
  dress_premium: ["dress_no_removable"],
};

function treeUseCaseSet(masterIndex) {
  const set = new Set();
  if (Array.isArray(masterIndex)) {
    for (const m of masterIndex) {
      if (m && typeof m.useCase === "string" && m.useCase) set.add(m.useCase);
    }
  }
  return set;
}

// Returns the tree-valid useCase for a (possibly coarse) value:
//   - the value itself when it already exists in the tree
//   - an aliased granular value when the coarse source maps to one present
//     in the tree (and the source itself is absent)
//   - null when it cannot be mapped (caller decides: drop & re-ask, or leave)
export function normalizeUseCaseForTree(useCase, masterIndex) {
  if (!useCase) return useCase;
  const known = treeUseCaseSet(masterIndex);
  if (known.has(useCase)) return useCase;
  for (const target of USE_CASE_ALIASES[useCase] || []) {
    if (known.has(target)) return target;
  }
  return null;
}

// Lazy-imported so this module can be loaded by tooling that
// doesn't have @prisma/client available (e.g. the eval harness
// running pure-function checks in CI). Cached after first await.
let _prisma = null;
async function getPrisma() {
  if (_prisma) return _prisma;
  const mod = await import("../db.server.js");
  _prisma = mod.default || mod;
  return _prisma;
}

// Smart Recommenders.
//
// Each merchant-defined recommender (stored as a DecisionTree row in
// Postgres) becomes a tool that the LLM can call when IT decides the
// customer needs a structured product recommendation. The tool takes
// typed attributes, runs them through the same deterministic
// resolver we already had (resolveTree), and returns a master SKU
// plus a product card.
//
// Architecture properties:
//   • LLM stays in charge of every turn — there is no funnel,
//     no chip pruning, no dispatcher hijack. The customer can
//     pivot ("actually I want shoes") and the LLM handles it
//     naturally because it never lost control.
//   • Multi-merchant by design — one DecisionTree row per intent
//     per shop. Aetrex has `orthotic`. A mattress merchant adds
//     `mattress` and `pillow`. Each becomes its own tool. The LLM
//     reads each tool's description and decides which one to call.
//   • Deterministic at the leaf — given the same attributes in,
//     the resolver returns the same master SKU out, every time.
//     No hallucinated SKUs. That's the "no maybe / no IF"
//     guarantee, just delivered as a tool the LLM uses instead
//     of as a dispatcher that takes over the turn.
//   • Backward compatible — the existing DecisionTree schema, the
//     existing admin UI, the existing seed file, and the existing
//     183-SKU Aetrex masterIndex all stay. We only stripped the
//     funnel orchestration; the data shape is unchanged.

// Inspect the masterIndex to discover which attribute keys exist
// and their observed value sets. Used to build tight tool schemas
// the LLM can reason about (typed enums when the value set is
// small, freeform string otherwise). The reserved keys we skip are
// the SKU/title/handle metadata.
const RESERVED_KEYS = new Set(["masterSku", "title", "productHandle"]);
const MAX_ENUM_SIZE = 20;

function discoverAttributes(definition) {
  const out = new Map();
  for (const m of definition?.resolver?.masterIndex || []) {
    if (!m || typeof m !== "object") continue;
    for (const [k, v] of Object.entries(m)) {
      if (RESERVED_KEYS.has(k)) continue;
      if (v === null || v === undefined) continue;
      if (!out.has(k)) out.set(k, new Set());
      // Coerce booleans and numbers to strings for the enum so the
      // LLM can supply "true"/"false"/"42" naturally.
      out.get(k).add(String(v));
    }
  }
  // "Unisex" is a product-side compatibility tag (a Unisex SKU
  // satisfies both Men's and Women's queries via genderMatch), not
  // a gender the customer can select. Keep it on products in the
  // masterIndex but hide it from the LLM's gender enum so the tool
  // can't be called with gender="Unisex".
  if (out.has("gender")) {
    out.get("gender").delete("Unisex");
  }
  return Array.from(out.entries()).map(([name, vals]) => ({
    name,
    values: Array.from(vals).sort(),
  }));
}

// Translate one DecisionTree row into a Claude tool definition.
// Returns null if the definition is malformed — the caller silently
// drops it and logs, never crashes the chat.
export function recommenderToToolDef(tree) {
  if (!tree || !tree.definition) return null;
  const v = validateDecisionTree(tree.definition);
  if (!v.ok) {
    console.error(
      `[recommender] tree ${tree.id} (intent=${tree.intent}) invalid; skipping`,
      v.errors.slice(0, 3).join("; "),
    );
    return null;
  }

  const attrs = discoverAttributes(tree.definition);
  const properties = {};
  // Per-attribute description hints. The LLM picks tool args based on
  // these strings; generic "X attribute" wording leaves it guessing
  // about clinical mappings (e.g. "ball-of-foot pain" → metSupport)
  // and producing wrong picks. Keep merchant-agnostic — only attribute
  // names that map to widely-recognized concepts get hints; everything
  // else falls back to the generic description.
  const ATTR_HINTS = {
    metSupport:
      "Set to 'true' when the customer mentions ball-of-foot pain, forefoot pain, metatarsal/metatarsalgia, OR Morton's neuroma — these signal a metatarsal pad is needed. Pass this IN ADDITION to 'condition' (which only carries one value). Example: customer reports BOTH arch pain AND forefoot pain → condition='overpronation_flat_feet' AND metSupport='true'. Don't omit it just because you already chose a different condition.",
    posted:
      "Set to 'true' when the customer mentions arch pain, flat feet, low arches, overpronation, ankle-rolling, or fallen arches — these signal the orthotic should be posted (rear-foot posted for medial support). Set to 'false' for medium/high arches with no overpronation.",
    arch:
      "Customer's arch type. 'Flat / Low Arch' for flat feet / low arches / overpronation; 'Medium / High Arch' for medium-to-high arches or when unknown.",
    condition:
      "Single dominant clinical condition. If the customer reports multiple complaints, pick ONE for this field but ALSO pass the relevant booleans (metSupport, posted) so the resolver sees the full clinical picture. Available enum values are listed below.",
    useCase:
      "What kind of shoe the orthotic goes in. Pick the closest enum match. 'cleats' for any spike/stud field/court sport (soccer, football, baseball, lacrosse), 'skates' for hockey, 'athletic_*' for sneakers/running/training, 'dress_*' for dress shoes, 'comfort' for general walking/standing/casual.",
    gender:
      "Allowed values: 'Men', 'Women', 'Kids'. NEVER pass 'Unisex' — that's a product-side compatibility tag, not a customer-facing gender.",
  };
  // The tree's own attributePrompts carry the LIVE vocabulary for the
  // vocabulary-bearing fields (useCase/condition); prefer them so the tool
  // description never drifts from the tree's actual values.
  const attributePrompts =
    tree.definition.attributePrompts && typeof tree.definition.attributePrompts === "object"
      ? tree.definition.attributePrompts
      : {};
  for (const a of attrs) {
    const treePrompt =
      a.name === "useCase" || a.name === "condition" ? attributePrompts[a.name] : null;
    const hint = treePrompt || ATTR_HINTS[a.name];
    const prop = {
      type: "string",
      description: hint || `${a.name} attribute used to refine the recommendation`,
    };
    if (a.values.length > 0 && a.values.length <= MAX_ENUM_SIZE) {
      prop.enum = a.values;
    }
    properties[a.name] = prop;
  }

  // Tool description Claude reads to decide WHEN to call. Three jobs:
  // (a) tell Claude this is the AUTHORITATIVE recommender for the
  // intent — preferred over search_products; (b) bound when NOT to
  // call (different product types, non-product topics); (c) when
  // requiredAttributes is set, instruct Claude to gather those FIRST
  // through normal conversation before calling the tool.
  const required = Array.isArray(tree.definition?.requiredAttributes)
    ? tree.definition.requiredAttributes.filter((s) => typeof s === "string" && s.trim())
    : [];
  const requiredLine = required.length > 0
    ? `\n\nALWAYS call this tool when the customer asks for a ${tree.intent} recommendation, even if you only ` +
      `have partial information. Pass whatever attributes the customer has mentioned. ` +
      `If required attributes (${required.join(", ")}) are missing, the tool will return a needMoreInfo response ` +
      `containing the exact natural-language questions to ask the customer. Read the tool's "instruction" field, ` +
      `write those questions to the customer in your reply, wait for their answer, then call this tool again ` +
      `with the complete set. Do NOT skip calling the tool just because you're missing attributes — the tool ` +
      `IS how you find out what to ask. Do NOT make up answers; only use values the customer provided.`
    : "";
  const description =
    `AUTHORITATIVE recommender for "${tree.intent}" queries on this shop. ` +
    `When a customer is asking for help picking a ${tree.intent} product ` +
    `("recommend a ${tree.intent}", "I need a ${tree.intent} for X", ` +
    `"which ${tree.intent} for Y condition"), call THIS tool — do NOT call ` +
    `search_products for the same purpose. The resolver returns a single ` +
    `deterministic master SKU based on the attributes you supply, so the ` +
    `customer never gets a wrong-fit pick. Provide every attribute the ` +
    `customer has mentioned or clearly implied; unspecified non-required ` +
    `attributes use sensible defaults. Returns one master SKU plus a product card.\n\n` +
    `Do NOT call this tool when the customer is asking about a different ` +
    `product type (e.g. shoes, sandals, socks, accessories), or about ` +
    `non-product topics (returns, sizing, shipping, store policies). For ` +
    `those, the existing search_products and other tools apply normally.` +
    requiredLine;

  return {
    name: `recommend_${tree.intent}`,
    description,
    input_schema: {
      type: "object",
      properties,
      required: [],
    },
  };
}

// Build the list of tool definitions for one shop. Skips
// recommenders that are disabled at the row level. Skips entirely
// when ShopConfig.decisionTreeEnabled is false. Hot path — called
// once per chat turn.
export async function buildRecommenderTools(shop, { decisionTreeEnabled, fitfinder = null, shopperText = "" }) {
  if (!shop || decisionTreeEnabled !== true) return { tools: [], trees: [] };
  const prisma = await getPrisma();
  let rows;
  try {
    rows = await prisma.decisionTree.findMany({
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
  } catch (err) {
    console.error("[recommender] load failed:", err?.message || err);
    return { tools: [], trees: [] };
  }
  // The orthotic finder (built from the live catalog) brings its own tool.
  const finder = await import("./orthotic-finder.server.js");
  const tools = [];
  const trees = [];
  for (const r of rows) {
    const td = finder.isFinderTree(r) ? finder.finderToolDef(r, { fitfinder, shopperText }) : recommenderToToolDef(r);
    if (td) {
      tools.push(td);
      trees.push(r);
    }
  }
  return { tools, trees };
}

// Resolve master SKU → product card using the same prefix-match
// approach the rest of the chat layer uses. Aetrex's variant SKUs
// are like "L100M07"; the master is "L100M". One DB query per
// recommendation; cached at the chat-turn boundary by the existing
// per-request cache pattern.
async function lookupProductByMasterSku(shop, masterSku) {
  if (!shop || !masterSku) return null;
  const m = String(masterSku).trim();
  if (!m) return null;
  const prisma = await getPrisma();
  // Try variant prefix match first — the most common Aetrex pattern.
  // Case-insensitive: masterIndex authored as "L1800U" must still match
  // shop variants like "l1800u-m" (lowercase + suffix). Postgres
  // `startsWith` defaults to case-sensitive; mode:"insensitive" maps
  // to ILIKE in the underlying SQL.
  const variant = await prisma.productVariant.findFirst({
    where: {
      sku: { startsWith: m, mode: "insensitive" },
      product: {
        shop,
        NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } },
      },
    },
    include: { product: true },
    orderBy: { sku: "asc" },
  });
  if (!variant) return null;
  const p = variant.product;
  return {
    handle: p.handle,
    title: p.title,
    productType: p.productType || undefined,
    sku: variant.sku || undefined,
    price: variant.price || undefined,
    compareAtPrice: variant.compareAtPrice || undefined,
    image: p.featuredImageUrl || undefined,
    url: `https://${String(shop).replace(/^https?:\/\//, "")}/products/${p.handle}`,
  };
}

// Filter the resolver's masterIndex to only SKUs the shop actually
// carries in its synced Shopify catalog. The merchant's recommender
// data may be a superset (e.g. shared across dev/prod replicas, or
// authored before products were imported); without this filter the
// resolver can pick a SKU that has no ProductVariant and the
// recommendation card is empty.
//
// One Postgres query per tool call. Could be cached per-shop if it
// shows up in profiling, but the variant table is indexed on `sku`
// and we're doing a single IN over <200 prefixes — fast.
async function filterMasterIndexByShop(shop, masterIndex) {
  if (!shop || !Array.isArray(masterIndex) || masterIndex.length === 0) {
    return masterIndex || [];
  }
  const prisma = await getPrisma();
  // For each master SKU, check whether ANY variant whose SKU starts
  // with it exists on this shop with a non-archived product. Batched
  // with OR-startsWith — Prisma converts to a SQL OR-LIKE chain.
  const prefixes = masterIndex.map((m) => m.masterSku).filter(Boolean);
  if (prefixes.length === 0) return [];
  let rows;
  try {
    rows = await prisma.productVariant.findMany({
      where: {
        // Case-insensitive prefix match — see lookupProductByMasterSku
        // for the same reasoning. masterIndex casing may not match the
        // merchant's actual variant SKU casing.
        OR: prefixes.map((p) => ({ sku: { startsWith: p, mode: "insensitive" } })),
        product: {
          shop,
          NOT: { status: { in: ["DRAFT", "draft", "ARCHIVED", "archived"] } },
        },
      },
      select: { sku: true },
    });
  } catch (err) {
    console.error("[recommender] catalog filter failed, using full index:", err?.message || err);
    return masterIndex;
  }
  const presentPrefixes = new Set();
  for (const r of rows) {
    const sku = String(r.sku || "").toLowerCase();
    for (const p of prefixes) {
      if (sku.startsWith(String(p).toLowerCase())) {
        presentPrefixes.add(p);
        break;
      }
    }
  }
  return masterIndex.filter((m) => presentPrefixes.has(m.masterSku));
}

// Execute a recommend_<intent> tool call. Returns the structure the
// LLM gets back — a plain object the agentic loop can stringify
// into a tool_result block. The product card travels back via the
// dedicated card-extraction path the chat layer already has, so we
// also surface `product` directly for that side channel.
export async function executeRecommenderTool({ toolName, input, shop, trees, conversationText, latestUserText, sessionMemoryExplicit, fitfinder = null }) {
  if (!toolName || !toolName.startsWith("recommend_")) {
    return { error: "not a recommender tool" };
  }
  const intent = toolName.slice("recommend_".length);
  const tree = (trees || []).find((t) => t.intent === intent);
  if (!tree) {
    return { error: `Recommender for intent="${intent}" is not enabled on this shop.` };
  }
  const finder = await import("./orthotic-finder.server.js");
  if (finder.isFinderTree(tree)) return finder.runFinderTool({ tree, shop, input, fitfinder, shopperText: conversationText || latestUserText || "" });
  if (!tree.definition?.resolver) {
    return { error: "Recommender has no resolver configured." };
  }

  // Sandals incompatibility guard. Aetrex's orthotic inserts (full-
  // length and heel-cup designs) don't fit in open-construction
  // sandals — the catalog has no sandal-compatible insert, and
  // every resolved SKU for a "orthotic for sandals" query is
  // wrong by definition. Catch the pattern early and return a
  // graceful redirect instead of letting the resolver pick a
  // wrong product (e.g. L100W Fashion-for-Heels). The chat layer
  // turns this into an honest text reply.
  //
  // SCOPE: only check the LATEST user message, NOT the whole
  // conversationText. Production trace bug: bot mentioned "sandals"
  // as an alternative on turn 6, then this guard fired on every
  // subsequent turn (turns 7–15) because the word "sandals" was
  // forever in the joined transcript. Customer asked "give me an
  // insole for sneakers" but kept hitting the sandal guard. With
  // latest-only scoping, the guard only fires when the customer is
  // ACTUALLY asking about sandals THIS turn.
  //
  // Match: orthotic-recommender-only AND latest user message
  // mentions sandal/sandals. The intent name is checked so this only
  // fires for the orthotic recommender, not for any future merchant
  // intents (e.g. "sandal" recommender wouldn't be self-blocking).
  const sandalScopeText = (typeof latestUserText === "string" && latestUserText.trim())
    ? latestUserText
    : (typeof conversationText === "string" ? conversationText : "");
  const isLatestOnly = sandalScopeText === latestUserText;
  if (
    /orthotic|insole|footbed/i.test(intent) &&
    isLatestOnly &&
    typeof sandalScopeText === "string" &&
    /\bsandals?\b/i.test(sandalScopeText)
  ) {
    console.log(
      `[recommender] sandal-incompatibility guard fired (latest-only) — customer asked for orthotic + sandals; ` +
        `Aetrex inserts don't fit open sandals. Returning redirect to footwear search.`,
    );
    return {
      error:
        "Orthotic inserts don't fit in open-construction sandals — the catalog doesn't have a sandal-compatible insert. " +
        "Tell the customer honestly that orthotics aren't designed for sandals, then offer to show ARCH-SUPPORTIVE SANDALS instead " +
        "(the merchant's Sandals category has built-in support — call search_products with categories ['Sandals'] and the gender " +
        "from context). Do NOT pick a non-sandal orthotic and pretend it fits.",
      sandalIncompatible: true,
      attributesUsed: input,
    };
  }

  // NOTE: The gap-fill-from-history step that used to live here
  // was removed. It scraped attributes the LLM had extracted from
  // free-text via brittle regex (e.g. "son" → gender=Men) and fed
  // them into the resolver — producing wrong product cards that
  // contradicted the LLM's own text. The orthotic-flow gate is now
  // the SOLE source of attributes for the resolver: chip clicks
  // populate them deterministically, the Haiku classifier extracts
  // them from natural language, and required-attrs gate below
  // honestly returns needMoreInfo if anything's still missing. No
  // half-LLM / half-resolver mixed mode.

  // Required-attributes gate. If the merchant declared any
  // requiredAttributes on this recommender (e.g. ["gender",
  // "useCase"]), the LLM must collect them through conversation
  // BEFORE the tool resolves a SKU. Without this gate the LLM is
  // too eager — a single attribute mention triggers a tool call,
  // defaults fill the rest, and the customer gets a generic pick
  // without ever being asked the questions a doctor would. The
  // gate returns a structured needMoreInfo response that tells
  // the LLM exactly what to ask next; on the next turn (after the
  // customer answers), the LLM calls the tool again with the
  // complete attribute set.
  const required = Array.isArray(tree.definition.requiredAttributes)
    ? tree.definition.requiredAttributes.filter((s) => typeof s === "string" && s.trim())
    : [];
  const attributePrompts = (tree.definition.attributePrompts && typeof tree.definition.attributePrompts === "object")
    ? tree.definition.attributePrompts
    : {};
  // Merge session memory's explicit facts under tool-call args so
  // the LLM doesn't have to re-state attributes the customer already
  // established. Tool call args (LLM's choice) win on conflict —
  // gives the LLM a way to override stale memory if the customer
  // pivoted. Empty/missing args fall back to memory. The merged
  // result becomes the canonical `input` for the rest of this
  // function (gate check + derivations + resolver call).
  const memoryAttrs = (sessionMemoryExplicit && typeof sessionMemoryExplicit === "object")
    ? sessionMemoryExplicit
    : {};
  const callArgs = input && typeof input === "object" ? input : {};
  const mergedInput = { ...memoryAttrs, ...callArgs };
  for (const k of Object.keys(callArgs)) {
    const v = callArgs[k];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
      if (memoryAttrs[k] != null && memoryAttrs[k] !== "") {
        mergedInput[k] = memoryAttrs[k];
      }
    }
  }
  // Shadow the function-scoped `input` so all downstream code paths
  // (derivations, enrichment, resolver) see the merged set without
  // having to rename them.
  input = mergedInput;

  if (required.length > 0) {
    const provided = mergedInput;
    const missing = required.filter((k) => {
      const v = provided[k];
      return v === undefined || v === null || (typeof v === "string" && !v.trim());
    });
    if (missing.length > 0) {
      const questions = missing.map((k) => {
        let prompt = attributePrompts[k];
        // Defensive: scrub any "unisex" mention from the gender
        // prompt text — Unisex is a product-side compatibility tag,
        // not a customer-facing gender choice. Merchants seeded
        // before that distinction was made still have stale prompt
        // text in their DB; this rewrites it on the fly so the LLM
        // doesn't echo a <<Unisex>> chip from the prompt.
        if (k === "gender" && typeof prompt === "string" && /unisex/i.test(prompt)) {
          prompt = "Who are these orthotics for — a man, woman, or kid?";
        }
        if (typeof prompt === "string" && prompt.trim()) return `- ${prompt}`;
        // Fallback question text by attribute name. Reasonable
        // defaults; merchant overrides via attributePrompts.
        return `- What is the customer's ${k}?`;
      }).join("\n");
      // Deterministic choice chips for the FIRST question, reusing the
      // orthotic gate's EXACT chip logic so LLM-owned mode keeps the same
      // tappable UX the pre-LLM gate emitted. The customer taps a chip; its
      // label round-trips as their next message and the classifier maps it
      // back to the enum value (the same path the gate relied on). Empty when
      // the attribute has no usable chips — the model then just asks in prose.
      // Best-effort: never let chip rendering break attribute collection.
      let chipDirective = "";
      try {
        const firstChips = orthoticChipLabelsForAttribute(tree, missing[0], mergedInput);
        if (Array.isArray(firstChips) && firstChips.length > 0) {
          chipDirective =
            `\n\nEnd your question with these tappable choice chips VERBATIM — each wrapped in << >>, ` +
            `space-separated, with nothing after them:\n` +
            firstChips.map((l) => `<<${l}>>`).join(" ");
        }
      } catch (chipErr) {
        console.warn(`[recommender] chip render failed (asking in prose): ${chipErr?.message || chipErr}`);
      }
      console.log(
        `[recommender] gate: ${missing.length} required attribute(s) missing on ` +
          `tool call — ${missing.join(", ")}. Asking LLM to gather first.` +
          (chipDirective ? ` (with chips for ${missing[0]})` : ""),
      );
      return {
        needMoreInfo: true,
        missingAttributes: missing,
        instruction:
          `Before recommending, ${missing.length === 1 ? "this attribute is" : "these attributes are"} still missing: ${missing.join(", ")}. ` +
          `ASK ONLY THE FIRST QUESTION below — one question per turn. Do NOT preface with "a few quick questions" or "I just need a few details" or number the question ("1.", "2.") — those phrasings imply a multi-question form, but each missing attribute is collected on its own conversational turn. Just ask the first question naturally as if it's the only thing you need. After the customer answers, call recommend_${tree.intent} again with what they gave you; the tool will tell you what's still missing.\n\nQuestions, in order (ask only the first):\n${questions}\n\nUse only the enum values listed in this tool's schema for those attributes.${chipDirective}`,
        attributesProvided: provided,
      };
    }
  }

  // Filter the masterIndex to SKUs the shop actually has in stock
  // BEFORE the resolver picks. Without this, the resolver can land
  // on a SKU that's in the merchant's recommender data but missing
  // from their Shopify catalog (e.g. dev shop with a partial sync,
  // or a recommender authored ahead of catalog imports), and the
  // resulting recommendation card comes through empty.
  const fullMasterIndex = tree.definition.resolver.masterIndex || [];
  const availableMasterIndex = await filterMasterIndexByShop(shop, fullMasterIndex);
  if (availableMasterIndex.length === 0) {
    console.warn(
      `[recommender] no resolver SKUs in shop catalog for intent=${intent} ` +
        `(masterIndex has ${fullMasterIndex.length}, shop has 0). ` +
        `Either the merchant's catalog isn't synced or the recommender data ` +
        `references SKUs that don't exist on this shop.`,
    );
    return {
      error:
        "None of the recommender's SKUs are present in this shop's catalog. " +
        "Please verify the catalog sync and the recommender's master-index data.",
      attributesUsed: input,
    };
  }
  if (availableMasterIndex.length < fullMasterIndex.length) {
    console.log(
      `[recommender] filtered masterIndex: ${availableMasterIndex.length}/${fullMasterIndex.length} ` +
        `SKUs are present in shop catalog`,
    );
  }

  const filteredResolver = { ...tree.definition.resolver, masterIndex: availableMasterIndex };

  // Bridge a coarse useCase (from the classifier / tool schema) to this
  // tree's granular vocabulary BEFORE anything filters on it. Alias-only
  // here — an unmappable value is left as-is (existing fallback behavior);
  // the gate separately drops unmappable values to re-ask the chip.
  if (input && input.useCase) {
    const normalizedUseCase = normalizeUseCaseForTree(input.useCase, availableMasterIndex);
    if (normalizedUseCase && normalizedUseCase !== input.useCase) {
      console.log(`[recommender] useCase normalize: ${input.useCase} → ${normalizedUseCase}`);
      input = { ...input, useCase: normalizedUseCase };
    }
  }

  // Apply tree-level derivations BEFORE resolving so merchant-
  // defined clinical mappings (condition → metSupport, arch →
  // posted, etc.) are honored. Without this, the resolver only
  // sees raw LLM-provided attributes and misses the implied ones.
  const derivedInput = applyDerivations(input || {}, tree.definition.derivations);
  if (Object.keys(derivedInput).length !== Object.keys(input || {}).length) {
    const added = Object.keys(derivedInput).filter((k) => !(k in (input || {})));
    if (added.length > 0) {
      console.log(`[recommender] derivations added attribute(s): ${added.join(", ")}`);
    }
  }

  // Clinical-keyword enrichment from the customer's conversation
  // text. The LLM only passes one `condition` value to the tool, so
  // when a customer reports MULTIPLE complaints (e.g. "both arch and
  // ball of foot"), the LLM picks one and drops the other — and the
  // resolver tie-breaks on lex order to a wrong-product (L700W
  // basic Speed instead of L705W Speed W/ Met Support).
  //
  // Mitigation: scan the customer's text for unambiguous clinical
  // signals and inject the derived booleans the LLM omitted. Only
  // ADDS attributes — never overrides what the LLM/derivations
  // already set. Aetrex-specific keyword set; safe because each
  // term has a clear 1:1 mapping to a resolver attribute.
  const enrichedInput = { ...derivedInput };
  const enrichedFromText = [];
  // Scope enrichment to the LATEST user message when the caller
  // supplies it. Production showed stale clinical signals from
  // earlier turns leaking into a later, unrelated query — e.g. a
  // turn 1 "ball-of-foot pain" forced metSupport=true on a turn 5
  // plantar-fasciitis-dress query, resolving to Fashion-for-Heels
  // instead of the correct PF specialty SKU. (The sandal guard above
  // reads the latest message only, for the same reason.) Falls back to
  // conversationText — the shopper's own messages — when the latest
  // message carries no clinical words.
  // Production trace: customer said "i have flat feet with ball of foot
  // pain" on turn 1, then answered chip questions for 4 turns. On the
  // resolve turn `latestUserText` is just "Women" (the gender chip) —
  // it contains no clinical signal at all, so scoping enrichment to it
  // misses both flat-feet AND ball-of-foot signals from turn 1, and
  // the resolver picks L820 (Train Posted) instead of L825 (Train
  // Posted W/ Met Support). When the latest message contains no
  // clinical vocabulary at all, fall back to the full conversation so
  // earlier symptom mentions still drive derivations. The "stale
  // signals leaking across topic switches" production trace this
  // protects against involved a switch from BoF to PF — that switch
  // would surface a NEW clinical signal in the latest message, so the
  // fallback wouldn't trigger.
  const CLINICAL_VOCAB_RE =
    /\b(pain|aching?|sore|fasciit|bunion|hammertoes?|neuroma|flat[\s-]?feet|flat[\s-]?foot|high[\s-]?arch|low[\s-]?arch|overpronat|underpronat|plantar|metatars|ball[\s-]?of[\s-]?(?:the[\s-]?)?foot|forefoot|fore[\s-]?foot|heel[\s-]?(?:pain|spurs?)|arch[\s-]?pain|diabet|neuropathy|arthritis|foot[\s-]?(?:pain|discomfort|issue))\b/i;
  const latestHasClinical = typeof latestUserText === "string" && CLINICAL_VOCAB_RE.test(latestUserText);
  const enrichmentText = latestHasClinical
    ? latestUserText
    : (typeof conversationText === "string" && conversationText.trim()
        ? conversationText
        : (typeof latestUserText === "string" ? latestUserText : ""));
  if (enrichmentText && enrichmentText.trim()) {
    const t = enrichmentText.toLowerCase();
    // useCase ← shoe-type vocabulary. The LLM sometimes calls
    // recommend_orthotic without useCase even when the customer's
    // intent is clear ("no pain just support" → casual/comfort,
    // "for running" → athletic_running, etc.). Without a useCase,
    // the resolver tie-breaks to a wrong line (e.g. Active Posted
    // for a comfort query). Derive useCase from unambiguous text
    // signals when not already set. Order matters — most specific
    // patterns first; "casual / no pain / everyday" lands on
    // comfort which is the broad fallback.
    if (!enrichedInput.useCase) {
      let derivedUseCase = null;
      if (/\b(running|run\b|jog(?:ging)?|marathon|5k|10k)\b/i.test(t)) {
        derivedUseCase = "athletic_running";
      } else if (/\b(gym|training|workout|cross[\s-]?train|crossfit|weights?[\s-]?lift|strength[\s-]?train)\b/i.test(t)) {
        derivedUseCase = "athletic_training";
      } else if (/\b(cleats?|soccer|football|baseball|lacrosse|rugby|spike[\s-]?shoes?)\b/i.test(t)) {
        derivedUseCase = "cleats";
      } else if (/\b(skates?|hockey|ice[\s-]?skate)\b/i.test(t)) {
        derivedUseCase = "skates";
      } else if (/\b(winter[\s-]?boots?|snow[\s-]?boots?|cold[\s-]?weather)\b/i.test(t)) {
        derivedUseCase = "winter_boots";
      } else if (/\b(work[\s-]?(?:boots?|shoes)?|standing[\s-]?all[\s-]?day|on\s+(?:my|her|his)\s+feet[\s-]?all[\s-]?day|warehouse|nursing|nurse)\b/i.test(t)) {
        derivedUseCase = "work_all_day";
      } else if (/\b(athletic|active|sports?|sport[\s-]?shoes?|tennis|basketball|court[\s-]?shoes?|sneakers?[\s-]+for[\s-]+(?:gym|run|sport))\b/i.test(t)) {
        derivedUseCase = "athletic_general";
      } else if (/\b(dress[\s-]?shoes?|heels?|pumps?|formal|wedding|gala|business[\s-]?(?:formal|attire))\b/i.test(t)) {
        derivedUseCase = "dress";
      } else if (/\b(no[\s-]?(?:pain|condition|issue)|just[\s-]?(?:want[\s-]?)?(?:comfort|support)|general[\s-]?(?:comfort|support)|everyday[\s-]?(?:wear|comfort|support|use)|casual|walking[\s-]?around|day[\s-]?to[\s-]?day|every[\s-]?day|just[\s-]?everyday|relief|nothing[\s-]?specific)\b/i.test(t)) {
        derivedUseCase = "comfort";
      }
      if (derivedUseCase) {
        enrichedInput.useCase = derivedUseCase;
        enrichedFromText.push(`useCase=${derivedUseCase}(text signal)`);
      }
    }

    // metSupport ← forefoot / ball-of-foot / metatarsal vocabulary.
    if (enrichedInput.metSupport === undefined || enrichedInput.metSupport === null) {
      if (/\b(ball[\s-]?of[\s-]?(?:the[\s-]?)?foot|forefoot|fore[\s-]?foot|metatars(?:al|algia)|morton(?:'?s)?[\s-]?neuroma|met[\s-]?pad|met[\s-]?head|toe[\s-]?box[\s-]?pain|under[\s-]?the[\s-]?ball)\b/i.test(t)) {
        enrichedInput.metSupport = true;
        enrichedFromText.push("metSupport=true(forefoot signal)");
      } else if (/\bno[\s-]?(?:specific[\s-]?)?(?:pain|condition|issue|forefoot|ball[\s-]?of[\s-]?foot|metatars)\b/i.test(t) || /\bjust[\s-]?(?:want[\s-]?)?(?:comfort|support)\b/i.test(t)) {
        // Explicit "no pain" / "just comfort" → metSupport not needed.
        // Setting false (vs leaving undefined) lets the resolver
        // de-prioritize met-support SKUs when scoring.
        enrichedInput.metSupport = false;
        enrichedFromText.push("metSupport=false(no-pain signal)");
      }
    }
    // posted ← arch pain / flat-foot / overpronation vocabulary.
    if (enrichedInput.posted === undefined || enrichedInput.posted === null) {
      if (/\b(arch[\s-]?pain|fallen[\s-]?arch(?:es)?|flat[\s-]?feet|flat[\s-]?foot|overpronat(?:e|ion|es|ing)|over[\s-]?pronat(?:e|ion|es|ing)|ankles?[\s-]?roll(?:ing)?[\s-]?in(?:ward)?|pronate[\s-]?inward|low[\s-]?arch(?:es)?)\b/i.test(t)) {
        enrichedInput.posted = true;
        enrichedFromText.push("posted=true(arch/flat-foot signal)");
      } else if (/\bhigh[\s-]?arch(?:es|ed)?\b/i.test(t) || /\bno[\s-]?(?:specific[\s-]?)?(?:pain|condition|issue|arch[\s-]?pain|flat[\s-]?feet|overpronation)\b/i.test(t) || /\bjust[\s-]?(?:want[\s-]?)?(?:comfort|support)\b/i.test(t)) {
        // High arches don't need posting; explicit no-condition
        // also means no posted needed. Setting false explicitly
        // lets the resolver de-prioritize Posted SKUs.
        enrichedInput.posted = false;
        enrichedFromText.push("posted=false(high-arch/no-pain signal)");
      }
    }
    // arch ← arch-type vocabulary. Resolver scoring uses this
    // heavily (+8 weight, vs +2 for posted). Without it, the
    // resolver guesses and tie-breaks badly. Mirror the posted
    // signals: flat/low → "Flat / Low Arch", high → "Medium /
    // High Arch", "I don't know" / "no idea" → "Medium / High
    // Arch" as the safer default per the seed JSON.
    if (!enrichedInput.arch) {
      if (/\b(flat[\s-]?feet|flat[\s-]?foot|fallen[\s-]?arch(?:es)?|low[\s-]?arch(?:es)?|overpronat(?:e|ion|es|ing))\b/i.test(t)) {
        enrichedInput.arch = "Flat / Low Arch";
        enrichedFromText.push("arch=Flat/Low(flat-foot signal)");
      } else if (/\b(high[\s-]?arch(?:es|ed)?|medium[\s-]?arch(?:es)?|normal[\s-]?arch(?:es)?)\b/i.test(t)) {
        enrichedInput.arch = "Medium / High Arch";
        enrichedFromText.push("arch=Medium/High(arch-type signal)");
      } else if (/\b(don'?t[\s-]?know|not[\s-]?sure|no[\s-]?idea|unsure|i[\s-]?dunno|i[\s-]?guess)\b/i.test(t) || /\bno[\s-]?(?:specific[\s-]?)?(?:pain|condition|issue)\b/i.test(t) || /\bjust[\s-]?(?:want[\s-]?)?(?:comfort|support)\b/i.test(t)) {
        // Default to medium/high — that's the seed's safe default
        // for unknown/no-issue customers. Per Aetrex's clinical
        // model: posted SKUs are for confirmed flat-foot; medium/
        // high arch = standard fit.
        enrichedInput.arch = "Medium / High Arch";
        enrichedFromText.push("arch=Medium/High(unknown/no-pain default)");
      }
    }
    // condition ← heel-spur / plantar-fasciitis / diabetic vocabulary
    // (only if condition not already specified — never override).
    if (!enrichedInput.condition) {
      // Single source of truth for free-text → canonical condition mapping
      // (condition-normalize.js). Order-deterministic so "Morton's neuroma"
      // resolves to mortons_neuroma and can NEVER collapse into
      // plantar_fasciitis or default to "none". `allowNone:true` keeps the
      // "just comfort / no specific pain" catch-all so the resolver still runs
      // on a no-condition answer. (Forefoot/met support is set separately via
      // metSupport.)
      const normalizedCondition = conditionFromText(t, { allowNone: true });
      // The prior inline chain matched a broader "just comfort" vocabulary than
      // condition-normalize's NONE_RE — the seed paraphrases its
      // "None — just want comfort" chip as "Just Comfort & Support" / "general
      // comfort" / "everyday support", and the resolver can't map those, so the
      // gate keeps re-asking. Keep that looser fallback so condition pins to
      // "none" and the resolver runs.
      const looseNone =
        /\b(?:no\s+(?:specific\s+)?(?:pain|condition|issue|concern)|just\s+(?:comfort|support|want\s+(?:comfort|support))|general\s+(?:comfort|support)|everyday\s+(?:comfort|support|wear)|no\s+(?:foot\s+)?problem|just\s+looking\s+for\s+(?:comfort|support|something)|comfort\s*(?:&|and)\s*support|nothing\s+specific|no\s+issues?|none\s+(?:really|specifically)?|not\s+(?:really|specifically)|just\s+everyday)\b/i.test(t);
      if (normalizedCondition && normalizedCondition !== "none") {
        enrichedInput.condition = normalizedCondition;
        enrichedFromText.push(`condition=${normalizedCondition}`);
      } else if (normalizedCondition === "none" || looseNone) {
        enrichedInput.condition = "none";
        enrichedFromText.push("condition=none(no-pain/just-comfort signal)");
      }
    }
  }
  // Final safety-net defaults. After all keyword-based enrichment,
  // if useCase / condition are STILL missing, fill the safest
  // defaults so the resolver always runs and returns a sensible
  // SKU rather than tie-breaking arbitrarily on partial input.
  // - useCase=comfort: broadest bucket; closest to "just give me
  //   a sensible everyday orthotic". Better default than letting
  //   the resolver guess.
  // - condition=none: "no specific clinical condition" — same
  //   bucket as the seed's "None — just want comfort" chip.
  if (!enrichedInput.useCase) {
    enrichedInput.useCase = "comfort";
    enrichedFromText.push("useCase=comfort(safety-net default)");
  }
  if (!enrichedInput.condition) {
    enrichedInput.condition = "none";
    enrichedFromText.push("condition=none(safety-net default)");
  }

  if (enrichedFromText.length > 0) {
    console.log(
      `[recommender] enriched from conversation text: ${enrichedFromText.join(", ")}`,
    );
  }

  const result = resolveTree(enrichedInput, filteredResolver);
  if (!result?.resolved) {
    return {
      error: result?.reason || "No matching product for the given attributes.",
      attributesUsed: result?.attrs || input,
    };
  }
  const product = await lookupProductByMasterSku(shop, result.resolved.masterSku);
  if (!product) {
    // The resolver picked a SKU that's in the masterIndex but the
    // matching Shopify product is missing, draft, archived, or has no
    // sellable variant. Returning the SKU + name with no product card
    // led to confident text ("X is your match") without an actual
    // clickable card — the customer was stuck. Better: return an
    // error so the LLM tells the customer honestly we don't have it
    // available right now and offers to search for alternatives.
    console.warn(
      `[recommender] resolver picked masterSku=${result.resolved.masterSku} ` +
        `but lookupProductByMasterSku returned null (product likely draft/archived/missing variant)`,
    );
    return {
      error:
        `The recommended SKU (${result.resolved.masterSku} — ${result.resolved.title}) ` +
        `isn't currently available in this shop's catalog. ` +
        `Tell the customer honestly that the specific match isn't in stock right now ` +
        `and offer to show similar products via search_products instead. ` +
        `Do NOT claim a product is "the perfect match" without an actual card.`,
      attributesUsed: result.attrs,
      missingProduct: { masterSku: result.resolved.masterSku, title: result.resolved.title },
    };
  }
  return {
    masterSku: result.resolved.masterSku,
    title: result.resolved.title,
    product,
    runnerUp: result.runnerUp
      ? { masterSku: result.runnerUp.masterSku, title: result.runnerUp.title }
      : null,
    attributesUsed: result.attrs,
    relaxedUseCase: result.relaxedUseCase || null,
    note: "Show this product as the recommended pick. The card data is in `product`.",
  };
}
