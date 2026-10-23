// Orthotic finder — fetch the live orthotic catalog, store it on the shop's
// "orthotic" recommender, and run it as Claude's recommend_orthotic tool.
// The logic lives in orthotic-finder.js (pure, tested against a snapshot of
// the real catalog in scripts/fixtures/aetrex-orthotics.json).

import prisma from "../db.server.js";
import { buildOrthoticCatalog, catalogForConversation, describeLine, lineAllowed, lineRulesOf, pickOrthotic, productFromNode, ruleNote } from "./orthotic-finder.js";
import { getDecisionTreeByIntent, incrementCompletedCount, saveDecisionTree } from "../models/DecisionTree.server.js";

export const FINDER_KIND = "catalog_finder";

// Five plain metafields per product — cheap enough for 50 products a page.
export const ORTHOTIC_PRODUCTS_QUERY = `
  query OrthoticFinderProducts($cursor: String) {
    products(first: 50, after: $cursor, query: "product_type:Orthotics status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        title
        handle
        variants(first: 1) { nodes { sku price } }
        gender: metafield(namespace: "custom", key: "gender_text") { value }
        activity: metafield(namespace: "custom", key: "attr_activity_shoe_type_for_filter") { value }
        details: metafield(namespace: "custom", key: "comfort_details") { value }
        helps: metafield(namespace: "product", key: "reccomended_for") { value }
        summary: metafield(namespace: "custom", key: "short_description") { value }
      }
    }
  }
`;

// graphql(query, variables) → data, from the app's admin client.
export function adminGraphql(admin) {
  return async (query, variables) => {
    const resp = await admin.graphql(query, { variables });
    const json = await resp.json();
    if (json?.errors?.length) throw new Error(json.errors.map((e) => e?.message).join("; "));
    return json.data;
  };
}

export async function fetchOrthoticProducts(graphql) {
  const out = [];
  let cursor = null;
  do {
    const data = await graphql(ORTHOTIC_PRODUCTS_QUERY, { cursor });
    const page = data?.products;
    for (const n of page?.nodes || []) out.push(productFromNode(n));
    cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

// Rebuild the finder from the live catalog and save it as the shop's
// "orthotic" recommender (created on first sync, switched on).
export async function syncOrthoticFinder({ shop, graphql }) {
  const products = await fetchOrthoticProducts(graphql);
  const catalog = buildOrthoticCatalog(products);
  if (catalog.items.length === 0) {
    return { ok: false, error: "No active products with product type \"Orthotics\" were found in Shopify." };
  }
  const existing = await getDecisionTreeByIntent(shop, "orthotic");
  await saveDecisionTree(shop, {
    id: existing?.id,
    name: existing?.name || "Aetrex Orthotic Finder",
    intent: "orthotic",
    triggerPhrases: existing?.triggerPhrases || JSON.stringify(["orthotic", "orthotics", "insole", "insoles", "arch support"]),
    triggerCategoryGroup: existing?.triggerCategoryGroup || "Orthotics",
    // The store team's line rules (lead / only when / never) survive a sync.
    definition: {
      kind: FINDER_KIND,
      syncedAt: new Date().toISOString(),
      finder: catalog,
      ...(existing?.definition?.kind === FINDER_KIND && existing.definition.rules ? { rules: existing.definition.rules } : {}),
    },
    // Switched on when first built; after that the merchant's on/off stays.
    enabled: existing?.definition?.kind === FINDER_KIND ? existing.enabled : true,
  });
  return {
    ok: true,
    productCount: products.length,
    lineCount: catalog.lines.length,
    lines: catalog.lines.map((l) => ({ id: l.id, name: l.name, genders: l.genders, count: l.count, bestFor: l.bestFor })),
    skipped: catalog.skipped,
  };
}

// After a catalog sync: keep an existing finder current. Never creates one.
export function refreshOrthoticFinderAsync({ admin, shop }) {
  (async () => {
    const existing = await getDecisionTreeByIntent(shop, "orthotic");
    if (existing?.definition?.kind !== FINDER_KIND) return;
    const r = await syncOrthoticFinder({ shop, graphql: adminGraphql(admin) });
    console.log(`[orthotic-finder] ${shop}: ${r.ok ? `refreshed — ${r.productCount} products, ${r.lineCount} lines` : r.error}`);
  })().catch((err) => console.error(`[orthotic-finder] ${shop}: refresh failed — ${err?.message || err}`));
}

export function isFinderTree(tree) {
  return tree?.definition?.kind === FINDER_KIND && Array.isArray(tree.definition?.finder?.lines);
}

function fitSection(fitfinder) {
  if (!fitfinder?.fits?.length) return "";
  const parts = [
    "\n\nFITs — this store sizes orthotic support as FITs (the same ones the FIT finder on product pages uses). " +
    "A FIT describes an orthotic insert only — never use it to describe shoes or sandals. " +
    "Use these names and explain them in these words when asked \"what's a FIT?\" or \"which FIT is right for me?\":\n" +
    fitfinder.fits.map((f) => `- ${f.label} — ${f.name}: ${f.description}`).join("\n"),
  ];
  if (fitfinder.questions?.length) {
    parts.push(
      "The store's own FIT questions (ask them this way; offer the 'how do I know' tip if they're unsure):\n" +
      fitfinder.questions.map((q) => `- ${q.text}${q.options.length ? ` (${q.options.join(" / ")})` : ""}${q.help ? ` How to tell: ${q.help}` : ""}`).join("\n"),
    );
  }
  parts.push("To work out a FIT, call this tool with arch and ball_of_foot_pain (no line needed) — it returns the FIT and saves it for them.");
  const saved = fitfinder.saved && fitfinder.fits.find((f) => f.key === fitfinder.saved);
  if (saved) {
    parts.push(
      `THIS CUSTOMER ALREADY HAS A FIT: ${saved.label} (${saved.name}), saved from the FIT finder. That answers arch and ball-of-foot pain — ` +
      `pass fit "${saved.key}" and don't ask those again. Mention it naturally ("Going by your ${saved.label}…") and that they can change it if something's different.`,
    );
  }
  return parts.join("\n");
}

// shopperText: what the shopper has said in this chat — a line that's only
// for certain conditions is offered once they've brought one up.
export function finderToolDef(tree, { fitfinder = null, shopperText = "" } = {}) {
  const rules = lineRulesOf(tree.definition);
  const lines = tree.definition.finder.lines.filter((l) => lineAllowed(rules[l.id], shopperText));
  const leads = lines.filter((l) => rules[l.id]?.mode === "lead").map((l) => l.name);
  const fits = fitfinder?.fits || [];
  return {
    name: `recommend_${tree.intent}`,
    description:
      "Find the right orthotic (insole) for the customer. Use it whenever they want help choosing one, or ask about FITs. Orthotics only: it never sizes or picks shoes, and a FIT never describes a shoe — shoe sizes come from True Fit when that tool is available.\n\n" +
      "Sound like an experienced, friendly orthotic fit specialist: warm, calm and sure of yourself, in plain words. " +
      "Briefly acknowledge what they told you (\"Ball-of-foot pain is really common in heels — good news, that's easy to support.\"), " +
      "ask one short question per message with tap choices, and when you recommend, say in a sentence or two why it suits them. " +
      "No jargon without a plain explanation, no long lists, no medical promises.\n\n" +
      "You need four things. Ask only for what you don't know yet:\n" +
      "1. Who it's for: men, women or kids.\n" +
      "2. The shoes or activity it's for (running, gym, dress shoes, heels, work boots, cleats, everyday sneakers…).\n" +
      "3. Arch type: flat/low (also: flat feet, overpronation, feet roll inward), medium/high, or not sure.\n" +
      "4. Ball-of-foot pain (metatarsalgia, Morton's neuroma): yes or no.\n" +
      "Never fill in an answer they haven't given — ask. If they don't know their arch type, use not_sure.\n" +
      "Then choose the line whose 'Best for' fits their shoes and needs — e.g. diabetes → the line made for diabetes; shoes " +
      "without a removable insole, heels or slim dress shoes → the dress, fashion or thin lines; extra cushioning → memory foam — " +
      "and call this tool. It picks the exact version for their arch and ball-of-foot pain and checks it's for sale; show what it returns. " +
      "Plantar fasciitis or heel pain doesn't change the line — answer the four questions as usual. " +
      "Orthotic inserts can't be worn in sandals or other open shoes. Never suggest, offer or pair an orthotic with sandals; when the customer asks for one, say so kindly and offer sandals with built-in arch support instead. When you're showing sandals, don't bring up orthotics at all." +
      fitSection(fitfinder) +
      (leads.length ? `\n\nThe store team leads with ${leads.join(" and ")}: when it suits the customer as well as another line, recommend it first.` : "") +
      "\n\nLines in this store (only these may be recommended):\n" + lines.map((l) => `- ${describeLine(l)}${ruleNote(rules[l.id])}`).join("\n"),
    input_schema: {
      type: "object",
      properties: {
        line: { type: "string", enum: lines.map((l) => l.id), description: "The line that fits their shoes and needs." },
        gender: { type: "string", enum: ["men", "women", "kids"] },
        arch: { type: "string", enum: ["flat_low", "medium_high", "not_sure"] },
        ball_of_foot_pain: { type: "string", enum: ["yes", "no"] },
        ...(fits.length ? { fit: { type: "string", enum: fits.map((f) => f.key), description: "Their FIT, when they already know it (stands in for arch and ball-of-foot pain)." } } : {}),
      },
      required: fits.length ? [] : ["line", "gender", "arch", "ball_of_foot_pain"],
    },
  };
}

// Only products the assistant can actually show (synced and active).
async function availableHandles(shop, handles) {
  const rows = await prisma.product.findMany({
    where: { shop, handle: { in: handles } },
    select: { handle: true, status: true },
  });
  return new Set(rows.filter((r) => !/^(draft|archived)$/i.test(r.status || "")).map((r) => r.handle));
}

export async function runFinderTool({ tree, shop, input, fitfinder = null, shopperText = "" }) {
  // Lines the store team doesn't want offered here are left out, so neither
  // the pick nor the "closest other line" can land on one.
  const rules = lineRulesOf(tree.definition);
  const catalog = catalogForConversation(tree.definition.finder, rules, shopperText);
  const asked = String(input?.line || "");
  if (asked && !catalog.lines.some((l) => l.id === asked) && tree.definition.finder.lines.some((l) => l.id === asked)) {
    const r = rules[asked];
    return {
      error: r?.mode === "only_when"
        ? `That line is only for customers who've said they have ${r.when.join(" or ")}. Choose the line that fits their shoes from: ${catalog.lines.map((l) => l.id).join(", ")}.`
        : `The store doesn't recommend that line. Choose the line that fits their shoes from: ${catalog.lines.map((l) => l.id).join(", ")}.`,
    };
  }
  const forSale = await availableHandles(shop, catalog.items.map((i) => i.handle));
  const result = pickOrthotic(catalog, input || {}, { available: (h) => forSale.has(h), fits: fitfinder?.fits || null });
  if (result.pick) await incrementCompletedCount(shop, tree.id);
  // A FIT worked out in the chat is saved to FITFinder by the widget, so
  // product pages open on it too.
  if (result.fit && result.fit.key !== fitfinder?.saved) {
    return { ...result, _events: [{ type: "fitfinder_fit", key: result.fit.key }] };
  }
  return result;
}
