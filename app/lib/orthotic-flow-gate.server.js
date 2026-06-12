// Orthotic-flow gate: a thin orchestrator that decides whether the
// state machine in orthotic-flow.server.js should take this turn,
// and if so, emits the SSE response server-side instead of letting
// the LLM run.
//
// Gate fires when:
//   - A `recommend_orthotic` decision tree is configured for the
//     shop, AND
//   - The conversation is mid-orthotic-flow — i.e. detectFlowState
//     identifies a current question node from the chip fingerprint
//     of the most recent assistant turn, AND
//   - The latest user reply maps to an enum value via Layer 1
//     (exact chip click) or Layer 2 (keyword enrichment).
//
// When the gate fires, this function:
//   - Advances the state machine,
//   - For a "question" step: emits the seed's question text + chips
//     (server-authoritative, no drift) and ends the SSE stream,
//   - For a "resolve" step: runs executeRecommenderTool through the
//     existing resolver/derivation/enrichment pipeline, emits the
//     product card via the standard `products` chunk, optionally
//     emits a brief LLM-generated description, and ends the stream,
//   - For a "done" step (no-match): emits a graceful redirect text
//     and ends the stream.
//
// When the gate does NOT fire, this function returns
// `{ handled: false }` and the normal LLM-driven runAgenticLoop
// proceeds unchanged. That keeps the gate opt-in and safe — any
// drift, off-topic, or free-text reply that the state machine
// can't confidently advance just falls through to the LLM as
// before.

import {
  getNextStep,
  mapAnswerToEnum,
  findNodeByChipsInText,
  findNodeById,
  getRootNode,
  nextNodeFromTransition,
  buildConstrainedAnswerPrompt,
  parseConstrainedAnswerResponse,
  isOffTopicReply,
  detectOrthoticIntent,
  hasOrthoticRejection,
  looksLikeFootwearCommit,
  mentionsNonOrthoticFootwear,
  preExtractAnswers,
  accumulateAnswers,
  looksLikeRecommendationRequest,
  looksLikeInformationalQuestion,
  looksLikeAvailabilityQuestion,
  looksLikeFunctionalQuestion,
  looksLikeTransactionalQuestion,
  messageCommitsToFootwear,
  messagePivotsToOrthotic,
  decorateGenderChipLabel,
  getGenderChipContextNoun,
} from "./orthotic-flow.server.js";
import { executeRecommenderTool } from "./recommender-tools.server.js";
import { buildStorefrontSearchCTA } from "./storefront-search-cta.server.js";
import { scrubInternalEnums } from "./chat-postprocessing.js";

// Format a recommender-returned product the same way chat-tools'
// extractProductCards does. Inlined (rather than imported) to keep
// the gate's dependency surface small — chat-tools.server.js pulls
// in Prisma, which breaks the eval-orthotic-gate runtime.
//
// Why this matters: variant.price comes out of the DB as a decimal
// string ("69.95"). The widget's fallback price formatter divides
// by 100 (the rest of the codebase uses cents elsewhere), so emitting
// the raw product object renders $0.70 for a $69.95 item. Setting
// price_formatted as a pre-formatted string the widget renders
// verbatim avoids the bug.
function formatRecommenderCard(product) {
  if (!product || !product.handle) return null;
  return {
    title: product.title,
    url: product.url,
    handle: product.handle,
    image: product.image || "",
    price_formatted: product.price ? `$${parseFloat(product.price).toFixed(2)}` : "",
    compare_at_price: product.compareAtPrice
      ? Math.round(parseFloat(product.compareAtPrice) * 100)
      : undefined,
  };
}

const ORTHOTIC_INTENT = "orthotic";

function sseChunk(obj) {
  // Gate-rendered turns bypass chat.jsx's emit-finalize chain, so this
  // is the last line of defense for customer-visible text: any future
  // interpolation of an unmapped enum value (the gate's humanize* maps
  // are a SECOND humanization table that can drift from the canonical
  // ORTHOTIC_ENUM_LABELS) gets scrubbed here. Idempotent and cheap.
  if (obj && obj.type === "text" && typeof obj.text === "string") {
    const scrubbed = scrubInternalEnums(obj.text);
    const next = typeof scrubbed === "string" ? scrubbed : scrubbed?.text;
    if (next) obj = { ...obj, text: next };
  }
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const CATALOG_SPECIFIC_FOOTWEAR_RE =
  /\b(?:sneakers?|trainers?|sandals?|slides?|boots?|booties|loafers?|oxfords?|clogs?|slip[-\s]?ons?|slippers?|mary[-\s]?janes?|wedges?|heels?)\b/i;
const CATALOG_COLOR_RE =
  /\b(?:black|brown|navy|blue|red|pink|tan|cognac|white|ivory|cream|gray|grey|charcoal|burgundy|wine|maroon|green|olive|yellow|orange|purple|gold|silver|bronze|taupe)\b/i;

function letsCatalogResolverOwnFootwearRequest(text) {
  if (!text) return false;
  if (CATALOG_SPECIFIC_FOOTWEAR_RE.test(text) || CATALOG_COLOR_RE.test(text)) return true;
  // Compare turns ("compare Jillian and Danika", "BioRocker vs UltraSky")
  // and named-product turns ("about the Jillian", "do you have Maui") name
  // their own anchors and don't need an upfront gender ask. Live trace
  // 2026-06-08: "compare Jillian and Danika" hit the gender gate which
  // asked "shopping for men's or women's?" — useless when the customer
  // already named two specific products.
  if (/\b(?:compare|comparison|vs\.?|versus|difference\s+between|which\s+(?:is|one\s+is)\s+(?:better|worse|more|best))\b/i.test(text)) {
    return true;
  }
  // Proper-noun product anchor (capitalized 4+ char word that isn't a
  // common stop-noun). Matches "Jillian", "Maui", "BioRocker", etc.
  // Same vocabulary the chat-tool-rewrite uses for named-product
  // anchor detection.
  if (/\b[A-Z][a-z]{3,}\b/.test(text) && !/^\s*(?:the|a|an|hi|hello|thanks|ok|yes|no|hey)\s+\w+/i.test(text.trim())) {
    return true;
  }
  return false;
}

// Detect "this assistant turn is a footwear gender clarifier" STRUCTURALLY,
// not by enumerating phrasings. The LLM (especially Haiku in cost mode)
// asks gender in endlessly varied word orders — "men's, women's, or kids'",
// "kids, men's, or women's", "men's or women's", chip-only, etc. Chasing
// each ordering with a regex is whack-a-mole. Instead: it's a gender ask if
// it offers Men+Women chips, OR it mentions BOTH men and women, is framed
// as a question/choice, and is NOT a product listing.
const GENDER_GATE_LISTING_RE = /\b(?:here\s+are|here'?s|found\s+these|i\s+found|take\s+a\s+look|check\s+out|these\s+are|comes?\s+in|also\s+comes?\s+in|available\s+in)\b/i;
const GENDER_GATE_ASK_CUE_RE = /\?|\b(?:shopping\s+for|are\s+you|which|would\s+you\s+like|looking\s+for|browse|for\s+(?:a\s+)?(?:man|woman|men|women|guy|gal|him|her))\b/i;

export function isGenderGateAsk(content) {
  const t = String(content || "");
  if (!t.trim()) return false;
  // Chips may carry a context noun ("<<Men's shoes>>" /
  // "<<Men's orthotics>>") — allow trailing words inside the marker.
  const menChip = /<<\s*(?:Men|Boys?)(?:['’]?s)?(?:\s+[^<>]*)?>>/i.test(t);
  const womenChip = /<<\s*(?:Women|Girls?)(?:['’]?s)?(?:\s+[^<>]*)?>>/i.test(t);
  if (menChip && womenChip) return true;
  const mentionsMen = /\bmen(?:['’]?s)?\b/i.test(t);
  const mentionsWomen = /\bwomen(?:['’]?s)?\b/i.test(t);
  if (!mentionsMen || !mentionsWomen) return false;
  if (GENDER_GATE_LISTING_RE.test(t)) return false; // a listing/pivot, not an ask
  return GENDER_GATE_ASK_CUE_RE.test(t);
}

export function countGenderGateAsks(messages = []) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((count, m) => {
    if (!m || m.role !== "assistant" || typeof m.content !== "string") return count;
    return count + (isGenderGateAsk(m.content) ? 1 : 0);
  }, 0);
}

// A clarifier may never repeat. The gate asks gender at most once; if it
// has already been asked and the customer's reply still didn't resolve
// gender, escape to a broad browse instead of re-asking. The customer can
// always narrow by men's/women's after seeing products — gender is a
// preference here, never a wall that can repeat.
export function shouldSoftEscapeFootwearGenderGate({ messages = [], answers = {} } = {}) {
  if (answers?.gender) return false;
  return countGenderGateAsks(messages) >= 1;
}

/**
 * Format a question node into customer-facing text with chip
 * markers. The widget's existing `<<Label>>` chip syntax is what
 * the renderer already understands.
 *
 * Chip labels come straight from the seed — no LLM rewrite, so the
 * customer's click on "None — just want comfort" maps cleanly back
 * to condition="none" via Layer 1 exact match next turn.
 */
const KIDS_GENDER_VALUES = new Set(["kids", "boys", "girls", "kid", "child"]);
function isKidsGenderValue(v) {
  if (typeof v !== "string") return false;
  return KIDS_GENDER_VALUES.has(v.toLowerCase());
}

// Some merchants tag Kids products as Unisex in Shopify (because the
// same SKU fits boys + girls). Treat a masterIndex row as Kids-eligible
// if either gender=Kids OR gender=Unisex with a kid/child/youth title.
function isKidsMasterIndexEntry(m) {
  if (!m) return false;
  if (isKidsGenderValue(m.gender)) return true;
  if (typeof m.gender === "string" && m.gender.toLowerCase() === "unisex") {
    const t = String(m.title || "").toLowerCase();
    if (/\b(kid|kids|child|children|youth|boys?|girls?)\b/.test(t)) return true;
  }
  return false;
}

// Compute the set of useCase values that have at least one Kids
// SKU in the resolver's masterIndex. Used to filter the q_use_case
// chips when the customer has selected Kids — we only want to ask
// about shoe types we actually carry a Kids orthotic for, instead
// of letting them pick "Dress shoes" and dead-ending into a
// "we don't have it" message.
function kidsAvailableUseCases(tree) {
  const masterIndex = tree?.definition?.resolver?.masterIndex;
  if (!Array.isArray(masterIndex)) return null;
  const out = new Set();
  for (const m of masterIndex) {
    if (isKidsMasterIndexEntry(m) && typeof m?.useCase === "string") {
      out.add(m.useCase);
    }
  }
  return out;
}

// Does this masterIndex entry satisfy the customer's accumulated
// answers? The single source of truth for "could this product be
// returned given what we know so far?"
//
// gender: strict (Kids uses isKidsMasterIndexEntry; adults match
//   entry.gender exactly OR Unisex which matches any adult).
// useCase: strict equality (case-insensitive). useCase is the
//   primary product family axis — no fuzziness.
// arch: strict equality on the canonical arch string.
// overpronation: "yes" forces posted entries; "no" / unset doesn't
//   constrain (the merchant may not carry posted variants for every
//   family and a non-posted orthotic is still a valid fallback).
// condition: lenient — most catalog entries don't tag condition;
//   the resolver routes condition through specialty matchers and
//   falls back to family SKUs when no specialty exists. Strict
//   filtering here would hide every condition chip for catalogs
//   without per-SKU condition tagging.
function entrySatisfiesAnswers(entry, answers) {
  if (!entry) return false;
  const a = answers || {};

  if (a.gender) {
    if (isKidsGenderValue(a.gender)) {
      if (!isKidsMasterIndexEntry(entry)) return false;
    } else {
      const eg = String(entry.gender || "").toLowerCase();
      const ag = String(a.gender).toLowerCase();
      if (eg !== ag && eg !== "unisex") return false;
    }
  }

  if (a.useCase) {
    const eu = String(entry.useCase || "").toLowerCase();
    const au = String(a.useCase).toLowerCase();
    if (eu !== au) return false;
  }

  if (a.arch) {
    const ea = String(entry.arch || "").toLowerCase();
    const aa = String(a.arch).toLowerCase();
    if (ea !== aa) return false;
  }

  if (String(a.overpronation || "").toLowerCase() === "yes") {
    if (!entry.posted) return false;
  }

  return true;
}

// Filter a node's chips to only those that lead to at least one
// real SKU given the customer's already-stated answers. Generic —
// works for q_gender, q_use_case, q_condition, q_arch,
// q_overpronation alike. For each chip value V on attribute A:
//
//   trial = {...answers, [A]: V}
//   keep V iff some masterIndex entry satisfies(trial)
//
// "none" / null chip values always survive — they're catch-alls
// the resolver treats as "no constraint". Same for chips with
// non-string values we don't know how to match against.
//
// Returns the original chips array when the masterIndex is missing
// or empty (no information to filter against) — fail-open so
// merchants without a populated catalog still see a working flow.
function chipsAchievableForNode(node, answers, tree) {
  const chips = Array.isArray(node?.chips) ? node.chips : [];
  if (chips.length === 0) return chips;
  const masterIndex = tree?.definition?.resolver?.masterIndex;
  if (!Array.isArray(masterIndex) || masterIndex.length === 0) return chips;
  const attr = node?.attribute;
  if (!attr) return chips;

  return chips.filter((chip) => {
    const value = chip?.value;
    if (typeof value === "string" && value.toLowerCase() === "none") return true;
    if (value === undefined || value === null) return true;
    const trial = { ...(answers || {}), [attr]: value };
    return masterIndex.some((m) => entrySatisfiesAnswers(m, trial));
  });
}

// A minimal greeting detector. Fires only when the customer's
// message LEADS with a greeting (so "Hi, I have flat feet" qualifies
// but "Do you have a high-arch option, by the way?" doesn't). The
// gate normally suppresses pure greetings before reaching here —
// this is for the mixed case where the customer greets + provides
// info in one turn.
const GREETING_LEAD_RE = /^\s*(?:hi|hello|hey|howdy|hiya|good\s+(?:morning|afternoon|evening|day))\b[\s,.!]/i;
function looksLikeGreetingLead(text) {
  if (typeof text !== "string") return false;
  return GREETING_LEAD_RE.test(text);
}

// Build a short, contextual acknowledgment to prefix the next chip
// question with. We only acknowledge when the customer JUST provided
// new info this turn (latestExtracted is non-empty) or led with a
// greeting — otherwise we'd add filler to every mid-flow chip turn.
//
// Phrasing stays plain and short. The goal is warmth, not narration:
// confirm what we heard, then ask the next question.
export function buildAcknowledgmentPrefix({ latestExtracted, rawUserText, answers }) {
  const parts = [];
  const greeted = looksLikeGreetingLead(rawUserText);
  if (greeted) parts.push("Hi there!");

  const newKeys = latestExtracted ? Object.keys(latestExtracted) : [];
  if (newKeys.length === 0) {
    return parts.length ? parts.join(" ") : "";
  }

  // 2026-06-03 fix: only acknowledge attributes that are NEW to this
  // turn — i.e. NOT already in accumulated `answers`. Haiku re-
  // extracts long-lived signals on every gate click ("foot pain"
  // surfaces on EVERY turn after the customer first said it), and
  // without this guard the bot prepends "Got it — foot pain. An
  // orthotic can definitely help with that." to the gender chip,
  // the use-case chip, the arch chip, and so on. The customer reads
  // the same condolence three times in a row and the bot looks
  // broken. Acknowledge ONLY on the click that introduced the
  // attribute.
  const isNew = (key, value) => {
    if (value == null || value === "") return false;
    const prior = answers ? answers[key] : undefined;
    if (prior == null) return true;
    // Same value already known → not new (suppress re-ack).
    if (String(prior).toLowerCase() === String(value).toLowerCase()) return false;
    return true;
  };

  const bits = [];
  let mentionedHelpableProblem = false;
  const cond = latestExtracted.condition;
  if (typeof cond === "string" && cond && cond !== "none" && isNew("condition", cond)) {
    bits.push(humanizeCondition(cond));
    mentionedHelpableProblem = true;
  }
  const useCase = latestExtracted.useCase;
  if (typeof useCase === "string" && useCase && isNew("useCase", useCase)) {
    const phrase = humanizeUseCase(useCase);
    if (phrase) {
      bits.push(phrase);
      mentionedHelpableProblem = true;
    }
  }
  const gender = latestExtracted.gender;
  if (
    typeof gender === "string" &&
    gender &&
    !cond && !useCase &&
    isNew("gender", gender)
  ) {
    // Only acknowledge gender alone if it's the only new info — otherwise
    // condition/useCase are more conversational signals to reflect.
    const g = humanizeGender(gender);
    if (g) bits.push(g);
  }

  if (bits.length === 0) {
    return parts.length ? parts.join(" ") : "";
  }

  const lead = greeted ? "Thanks for sharing —" : "Got it —";
  const joined = bits.length === 1
    ? bits[0]
    : bits.length === 2
      ? `${bits[0]} and ${bits[1]}`
      : `${bits.slice(0, -1).join(", ")}, and ${bits[bits.length - 1]}`;
  // "An orthotic can definitely help with that" only reads correctly
  // when `bits` named something an orthotic actually helps with —
  // a condition (plantar fasciitis) or a use case (running). Gender
  // alone is not a "that" — adding the tail produces nonsense like
  // "Got it — women's. An orthotic can definitely help with that."
  // which is what a customer saw in the wild.
  const tail = mentionedHelpableProblem ? " An orthotic can definitely help with that." : "";
  parts.push(`${lead} ${joined}.${tail}`);
  return parts.join(" ");
}

function humanizeCondition(value) {
  const map = {
    plantar_fasciitis: "plantar fasciitis",
    heel_spurs: "heel spurs",
    heel_pain: "heel pain",
    metatarsalgia: "ball-of-foot pain",
    ball_of_foot_pain: "ball-of-foot pain",
    flat_feet: "flat feet",
    fallen_arches: "fallen arches",
    high_arches: "high arches",
    overpronation: "overpronation",
    bunions: "bunions",
    neuroma: "Morton's neuroma",
    achilles: "Achilles pain",
    knee_pain: "knee pain",
    back_pain: "back pain",
    diabetes: "diabetic foot care",
  };
  const key = String(value || "").toLowerCase();
  if (map[key]) return map[key];
  return key.replace(/_/g, " ");
}

function humanizeUseCase(value) {
  const map = {
    athletic: "athletic shoes",
    running: "running shoes",
    walking: "walking shoes",
    casual: "casual shoes",
    dress: "dress shoes",
    work: "work boots",
    boots: "boots",
    sandals: "sandals",
    hiking: "hiking boots",
    kids: "",
  };
  const key = String(value || "").toLowerCase();
  if (key in map) return map[key];
  return "";
}

function humanizeGender(value) {
  const key = String(value || "").toLowerCase();
  if (key === "men" || key === "male") return "men's";
  if (key === "women" || key === "female") return "women's";
  if (KIDS_GENDER_VALUES.has(key)) return "kids'";
  return "";
}

// For the condition question: filter chips only for Kids customers
// (where the dead-end risk is real because the merchant has limited
// Kids SKUs and the resolver is strict-Kids). For adults, return
// null so the consumer skips filtering and shows all conditions.
//
// Why no filtering for adults: most masterIndex items don't set an
// explicit `condition` field — only specialty SKUs (plantar_fasciitis,
// heel_spurs, metatarsalgia, etc.) do. The resolver uses
// CONDITION_TARGETS regex matchers and SHOE_CONTEXT_LOCKS to map a
// customer's stated condition to either a specialty SKU or the
// base family SKU. My old narrow filter (require gender+useCase+
// condition all match) hid every condition chip for Women+athletic
// because no L2900W item literally has condition="heel_spurs" set.
// The resolver would have happily returned the L2900W family SKU.
function availableConditionsForAnswers(tree, answers) {
  const masterIndex = tree?.definition?.resolver?.masterIndex;
  if (!Array.isArray(masterIndex) || !answers) return null;
  // Adults: no condition filtering. Resolver handles all conditions
  // via specialty tests and shoe-context locks.
  if (!isKidsGenderValue(answers.gender)) return null;
  // Kids: strict filter. Only show conditions present on Kids items.
  // "none" is always allowed as the catch-all.
  const out = new Set(["none"]);
  for (const m of masterIndex) {
    if (!isKidsMasterIndexEntry(m)) continue;
    if (typeof m?.condition === "string" && m.condition) {
      out.add(m.condition);
    }
  }
  return out;
}

function renderQuestionText(node, answers, tree, context = null) {
  if (!node || node.type !== "question") return "";
  let q = String(node.question || "").trim();
  if (node.id === "q_overpronation" || node.attribute === "overpronation") {
    q = "Do your ankles tend to roll inward when you walk or stand?";
  }
  // Defensive Unisex / Other / Either / Both strip — production
  // showed those labels appearing on q_gender despite the canonical
  // seed file having only Men/Women/Kids. The DB-stored tree may
  // have drifted (manual edit, older seed version, etc.); strip
  // them at emit time so customers never see a non-gender chip.
  // Also strips for the gender attribute specifically, but the
  // filter is safe to run on any node — the labels never appear
  // on non-gender questions.
  const NONSENSE_GENDER = /^(?:unisex|other|either|both)\b/i;
  let chips = (node.chips || []).filter((c) => {
    const label = String(c?.label || "").trim();
    return label && !NONSENSE_GENDER.test(label);
  });

  // Dynamic chip availability: for every chip on this node, ask the
  // catalog "if the customer picked this, would we have a product to
  // show them?" Drop the chips that would dead-end. One rule covers
  // gender (no Kids SKUs → drop Kids), useCase (no women's work
  // boots → drop work for women), arch (no Flat / Low entries for
  // this gender+useCase → drop the chip), overpronation, and the
  // Kids-strict condition path — all via the same trial-match
  // against masterIndex.
  chips = chipsAchievableForNode({ ...node, chips }, answers, tree);

  // Kids-specific condition tightening. For Kids the merchant
  // usually carries a narrow set of specialty SKUs; dead-ends on
  // condition chips are real. Adults fall through (the resolver
  // has condition fallbacks).
  if (node.attribute === "condition" && answers && isKidsGenderValue(answers.gender)) {
    const allowed = availableConditionsForAnswers(tree, answers);
    if (allowed && allowed.size > 0) {
      chips = chips.filter((c) => allowed.has(c.value));
    }
  }

  const originalChipCount = Array.isArray(node.chips) ? node.chips.length : 0;
  let chipLabels = chips.map((c) => String(c.label).trim()).filter(Boolean);

  // Context-carrying gender chips: the GENDER question's chips carry
  // the domain noun ("Men's orthotics" / "Women's orthotics" /
  // "Kids' orthotics") so a tapped chip is self-contained when it
  // round-trips as the customer's next message. Composed server-side
  // via the SAME decorate function the match path uses — emit and
  // match can never drift. Only the gender-attribute node; every
  // other node's chips are unchanged.
  if (node.attribute === "gender") {
    const contextNoun = getGenderChipContextNoun(tree?.definition);
    chipLabels = chipLabels.map((l) => decorateGenderChipLabel(l, contextNoun));
  }

  // Safety: if the node originally had chips but every one was
  // filtered out, every path forward dead-ends given the customer's
  // current answers. Don't ask a chip-less question — return empty
  // so the gate falls through to the LLM, which can say honestly
  // "we don't carry that combination" and offer alternatives.
  if (originalChipCount > 0 && chipLabels.length === 0) {
    return "";
  }

  const chipLine = chipLabels.length > 0
    ? chipLabels.map((l) => `<<${l}>>`).join(" ")
    : "";

  // Acknowledgment prefix: greet the customer back if they led with a
  // greeting, and reflect any info they just provided this turn so the
  // chip question doesn't feel like the bot ignored them.
  let prefix = "";
  if (context) {
    prefix = buildAcknowledgmentPrefix({
      latestExtracted: context.latestExtracted || {},
      rawUserText: context.rawUserText || "",
      answers,
    });
  }

  const body = chipLine ? `${q}\n\n${chipLine}` : q;
  return prefix ? `${prefix}\n\n${body}` : body;
}

/**
 * Apply skipIfKnown / autoSkipIfSingle node transitions to walk
 * past nodes whose answer is already known. The state machine's
 * getNextStep already does this once per call — but if a chain of
 * skippable nodes precedes a question, we need to keep walking.
 *
 * Returns the next step, possibly after multiple skips. Bounded at
 * 8 hops to defend against pathological cyclic transitions.
 */
function resolveSkippableSteps(state, tree) {
  let cur = state;
  for (let i = 0; i < 8; i++) {
    const step = getNextStep(cur, tree);
    if (step.type !== "question") return step;
    const node = step.node;
    if (node.skipIfKnown && cur.answers[node.attribute] !== undefined) {
      const nextId = nextNodeFromTransition(node, cur.answers[node.attribute]);
      if (!nextId) return step;
      cur = { ...cur, currentNodeId: nextId };
      continue;
    }
    return step;
  }
  return getNextStep(cur, tree);
}

/**
 * Main entry point. See module docstring for behavior contract.
 *
 * Parameters:
 *   - messages: full conversation history (last item is current user turn)
 *   - tree: the orthotic DecisionTree row (with .definition)
 *   - shop: shop domain (for resolver's catalog filter)
 *   - controller / encoder: SSE writer pair from chat.jsx
 *   - anthropic: Anthropic SDK client (used for Layer 3 fallback)
 *   - haikuModel: model id for the optional Layer 3 free-text mapper
 *
 * Returns:
 *   { handled: true }  if the gate took the turn (caller should not
 *                      run the LLM agentic loop)
 *   { handled: false } otherwise
 */
export async function maybeRunOrthoticFlow({
  messages,
  tree,
  shop,
  controller,
  encoder,
  anthropic,
  haikuModel,
  classifiedIntent,
  resolverState = null,
  storefrontSearchUrlPattern = "",
  ctaOverrides = [],
}) {
  if (!tree || tree.intent !== ORTHOTIC_INTENT) return { handled: false };
  if (!tree.definition || !Array.isArray(tree.definition.nodes)) {
    return { handled: false };
  }
  if (!Array.isArray(messages) || messages.length === 0) return { handled: false };

  // ─── M1.3 ROUTER YIELD CASES (run before any gate logic) ────
  //
  // CASE C — RESOLVER_STRONG_ACTION: resolver already produced a
  // catalog-grounded next action (recommend / no_match /
  // controlled_oos). The LLM will use resolverState to answer; the
  // gate must not contradict that.
  //
  // CASE D — RESOLVER_ASK_WITH_SCOPE: resolver wants to ask, but it
  // already matched/inferred catalog scope (category, color, or a
  // specific product). The gate must not hard-ask gender on top.
  // Condition alone is NOT enough scope — those still flow through
  // the orthotic/path disambig logic below.
  if (resolverState && resolverState.type === "resolver_state") {
    const action = resolverState.recommended_next_action?.type;
    const matched = resolverState.matched_constraints || {};
    const inferred = resolverState.inferred_constraints || {};
    const hasCategoryScope = !!(matched.category || inferred.category?.value);
    const hasColorScope = !!(matched.color || inferred.color?.value);
    const hasSpecificProduct = !!matched.specificProduct;
    const impossibleCount = Array.isArray(resolverState.impossible_constraints)
      ? resolverState.impossible_constraints.length
      : 0;
    const isOrthoticScope =
      matched.category === "orthotics" ||
      inferred.category?.value === "orthotics" ||
      classifiedIntent?.isOrthoticRequest === true;

    // recommend and controlled_oos are always authoritative — they
    // come straight from a catalog match. no_match is authoritative
    // ONLY when impossible_constraints is non-empty; an empty
    // candidate preview alone is not catalog truth (M2 invariant).
    // For an orthotic-scope turn, defer ALL resolver actions to the
    // orthotic recommender flow — the recommender owns clinical
    // attribute collection (condition / useCase / arch /
    // overpronation), the resolver only owns catalog scope.
    if ((action === "recommend" || action === "controlled_oos") && !isOrthoticScope) {
      return { handled: false, case: "C_resolver_strong_action" };
    }
    if (action === "no_match" && impossibleCount > 0 && !isOrthoticScope) {
      return { handled: false, case: "C_resolver_strong_action" };
    }
    if (action === "ask" && (hasCategoryScope || hasColorScope || hasSpecificProduct) && !isOrthoticScope) {
      return { handled: false, case: "D_resolver_ask_with_scope" };
    }
  }
  // CASE D continued — classifier says footwear request AND latest
  // message contains a concrete footwear noun. Same yield: this is a
  // catalog turn, not an orthotic turn.
  const FOOTWEAR_NOUN_GLOBAL_RE =
    /\b(?:shoes?|footwear|sneakers?|sandals?|boots?|loafers?|clogs?|wedges?|heels?|oxfords?|slippers?|moccasins?|trainers?|pumps?|mules?|mary[- ]janes?|slip[- ]ons?|flats?)\b/i;
  const latestText =
    messages.length > 0 && messages[messages.length - 1]?.role === "user"
      ? String(messages[messages.length - 1]?.content || "")
      : "";
  if (
    classifiedIntent?.isFootwearRequest === true &&
    FOOTWEAR_NOUN_GLOBAL_RE.test(latestText)
  ) {
    return { handled: false, case: "D_footwear_request_with_noun" };
  }

  // The latest message must be from the user — that's what we're
  // mapping. If the last turn is somehow assistant-tail or empty,
  // fall through to the normal flow.
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return { handled: false };
  const rawUserText = typeof last.content === "string" ? last.content : "";
  if (!rawUserText.trim()) return { handled: false };

  // Product-info follow-up. The customer is asking about a SPECIFIC
  // product already in the conversation ("does the X come in other
  // colors", "is the Y available in size 9", "what's the price of Z").
  // These look orthotic-shaped to the classifier when the product
  // name contains "Orthotic" (e.g. Aetrex's "Fiji Orthotic Women's
  // Flips" sandals) — keyword match wrongly routes the customer into
  // the question flow. Bail out so the LLM handles the question with
  // catalog context.
  const PRODUCT_INFO_RE =
    /\b(?:do|does|is|are|will|would|can|how|what|when|where|which|why)\b[^?]{0,80}?\b(?:come|comes|available|stock|stocked|sale|sized?|price|cost|color|colour|width|fit|fits|ship|shipping|return)\b/i;
  const PRODUCT_EXPLANATION_FOLLOWUP_RE =
    /\b(?:what|why|how)\b[^?]{0,120}\b(?:makes?|better|good|help|work|different)\b/i;
  if (PRODUCT_INFO_RE.test(rawUserText) || PRODUCT_EXPLANATION_FOLLOWUP_RE.test(rawUserText)) {
    // Only bail when there's prior assistant context (otherwise this
    // is a genuine fresh question, not a follow-up). Cheap check:
    // any prior assistant turn with non-trivial text.
    const hasPriorAssistant = messages.slice(0, -1).some(
      (m) => m && m.role === "assistant" && typeof m.content === "string" && m.content.trim().length > 20,
    );
    if (hasPriorAssistant) {
      console.log(
        `[orthotic-flow] product-info follow-up detected; falling through to LLM (no orthotic question flow)`,
      );
      return { handled: false };
    }
  }

  // Unified gate: accumulate every Layer-1/2 answer signal across
  // the whole conversation, then walk the seed tree from root and
  // emit the next unanswered question. Replaces the old bootstrap-
  // vs-continuation split, which was broken in production because
  // the chip `<<>>` markers don't survive the widget's history
  // round-trip — so findNodeByChipsInText returned null on every
  // turn and the chip-fingerprint continuation never engaged.
  //
  // Engagement rule: the gate is "active" if ANY of these hold:
  //   1. detectOrthoticIntent matches the latest message (fresh
  //      bootstrap), OR
  //   2. detectOrthoticIntent matches anywhere in history (mid-flow
  //      pivot back into the orthotic flow), OR
  //   3. accumulateAnswers found ≥1 prior answer (we're already
  //      mid-flow even if intent words have faded from history).
  //
  // Otherwise the LLM stays in charge — same fall-through behavior
  // as before. Anything the gate emits uses seed-byte-exact chips.
  const priorMessages = messages.slice(0, -1);
  const accumulated = accumulateAnswers(priorMessages, tree.definition);
  const latestExtracted = preExtractAnswers(rawUserText, tree.definition);

  // Classifier-extracted attributes from Haiku take PRECEDENCE over
  // the legacy regex pre-extraction for the latest message. Haiku
  // handles natural language we used to chase with regex patches —
  // "my son" → Kids (not Men), "high arch" → high_arch condition,
  // typos like "orhtotic", curly apostrophes, kid signals like
  // "my 9-year-old" or "grandson". Only applied when the classifier
  // ran successfully; on null we keep the regex extraction so the
  // gate never goes offline on classifier failure.
  //
  // Chip-scope guard (added 2026-06-03):
  // When the prior assistant message was a recognized seed chip
  // question (q_condition, q_arch, q_useCase, …), the user's
  // reply is an answer to THAT chip's attribute. Accepting
  // classifier-derived gender / useCase / arch from the same
  // click is unsafe — Haiku reads the chip text + the click
  // text and frequently regenerates a stale subject attribute
  // (e.g. gender=Women from session memory contamination) on
  // what was really a condition click.
  //
  // Live failure 2026-06-03: customer answered the men's flow
  // through q_gender → q_useCase → q_arch (all correct), then
  // clicked "Ball-of-foot pain / metatarsalgia" on q_condition.
  // Classifier returned gender=Women → subject-pivot reset
  // dropped arch + useCase → bot re-asked q_arch. Loop.
  let priorChipAttribute = null;
  {
    const priorLastAssistant = [...priorMessages].reverse().find((m) => m.role === "assistant");
    const priorLastText = priorLastAssistant && typeof priorLastAssistant.content === "string"
      ? priorLastAssistant.content
      : "";
    if (priorLastText && /<<[^<>]+>>/.test(priorLastText)) {
      const priorNode = findNodeByChipsInText(priorLastText, tree.definition);
      priorChipAttribute = priorNode?.attribute || null;
    }
  }
  if (classifiedIntent && classifiedIntent.attributes) {
    const a = classifiedIntent.attributes;
    // Detect an EXPLICIT subject change in the literal user text.
    // Only literal subject phrasings ("for my wife", "actually
    // men's", "no, women") may overturn the chip-scope guard.
    const SUBJECT_OVERRIDE_RE = /\b(?:for\s+my\s+(?:wife|husband|mom|mother|dad|father|son|daughter|partner|spouse|kid|child|grandson|granddaughter)|actually\s+(?:men|women|kids|boys|girls)|no\s*,?\s+(?:men|women|kids|boys|girls)|this\s+is\s+for\s+(?:my\s+\w+|me))/i;
    const userExplicitlyChangedSubject = SUBJECT_OVERRIDE_RE.test(rawUserText);
    const chipScopeIsNonGender = priorChipAttribute && priorChipAttribute !== "gender";
    const chipScopeIsNonUseCase = priorChipAttribute && priorChipAttribute !== "useCase";
    const chipScopeIsNonCondition = priorChipAttribute && priorChipAttribute !== "condition";

    if (a.gender) {
      // Block classifier-derived gender when the prior question
      // was a non-gender chip AND the user didn't explicitly say
      // anything subject-related in free text.
      if (chipScopeIsNonGender && !userExplicitlyChangedSubject) {
        console.log(
          `[orthotic-flow] chip-scope: ignored classifier gender=${a.gender} ` +
            `(prior question was ${priorChipAttribute} chip; user text not a subject change)`,
        );
      } else {
        latestExtracted.gender = a.gender;
      }
    }
    if (a.useCase) {
      // Same guard for useCase — chip-context bleed in the
      // opposite direction (a condition click should not change
      // useCase silently).
      if (chipScopeIsNonUseCase && !userExplicitlyChangedSubject) {
        // useCase isn't subject-bound, but we still avoid
        // classifier-derived useCase contamination when the
        // user clicked a different attribute's chip.
        // Verbose log only when it would have OVERWRITTEN an
        // existing accumulated value — silent no-op otherwise.
        if (accumulated.useCase && accumulated.useCase !== a.useCase) {
          console.log(
            `[orthotic-flow] chip-scope: ignored classifier useCase=${a.useCase} ` +
              `(prior question was ${priorChipAttribute} chip; ` +
              `accumulated useCase=${accumulated.useCase} preserved)`,
          );
        }
      } else {
        latestExtracted.useCase = a.useCase;
      }
    }
    if (a.condition) {
      // Condition is the one classifier value we want to ACCEPT
      // even outside a condition chip — a customer can mention
      // a condition in free text any turn. But we still gate it
      // when the prior chip was specifically a non-condition chip
      // AND the click text doesn't read like a condition mention,
      // to avoid Haiku regenerating a stale condition from chip
      // text it read alongside the answer.
      // For now we keep the original behavior here; the live
      // failure was on the GENDER side, not condition.
      latestExtracted.condition = a.condition;
    }
  }

  // Chip-context defense for the overpronation chip question.
  // Production trace: when the assistant's prior message was the
  // overpronation chip ("...do your ankles roll inward or do you have
  // flat-feet symptoms?") and the customer answers "Yes", Haiku reads
  // the chip text + Yes and infers `condition=overpronation_flat_feet`.
  // That's wrong: the chip's purpose is to set `overpronation=yes`
  // ONLY, not to inject a clinical condition the customer never named
  // in free text. Drop the spurious condition extraction when we
  // detect this combination. Also drop spurious arch extraction in
  // the same shape ("Flat / Low Arch" Y/N answer is for the arch
  // chip, not the condition chip).
  {
    const priorLastAssistant = [...priorMessages].reverse().find((m) => m.role === "assistant");
    const priorLastText = priorLastAssistant && typeof priorLastAssistant.content === "string"
      ? priorLastAssistant.content
      : "";
    const priorWasOverpronationChip = /ankles\s+roll\s+inward|flat-feet\s+symptoms/i.test(priorLastText);
    const latestIsYesNo = /^\s*(?:yes|yeah|yep|yup|sure|absolutely|definitely|no|nope|not\s+(?:really|sure)|maybe|kind\s+of|sort\s+of)[\s.!?]*$/i
      .test(rawUserText);
    if (
      priorWasOverpronationChip &&
      latestIsYesNo &&
      latestExtracted.condition === "overpronation_flat_feet"
    ) {
      console.log(
        `[orthotic-flow] chip-context defense: dropping spurious condition=overpronation_flat_feet ` +
          `from Y/N answer to overpronation chip (prior msg was the chip question)`,
      );
      delete latestExtracted.condition;
    }
  }

  // Kids-sticky: once gender=Kids is established, it CANNOT be silently
  // flipped to Men/Women by a subsequent message. Production trace —
  // customer chose Kids on q_gender, the LLM later asked an unsolicited
  // 'boy or girl?' follow-up with Men's/Women's chips, customer
  // clicked Women's, Layer 2 mapped that to gender=Women, the resolver
  // returned a Women's adult orthotic for what was supposed to be a
  // child. Letting an adult-gender override a kids-gender is virtually
  // never what the customer means; if they truly need to switch from
  // a child to themselves they say so explicitly ('actually it's for
  // me' / 'it's for my mom'), which the LLM handles outside the gate.
  if (
    isKidsGenderValue(accumulated.gender) &&
    latestExtracted.gender &&
    !isKidsGenderValue(latestExtracted.gender)
  ) {
    console.log(
      `[orthotic-flow] kids-sticky: blocking gender override ` +
        `(accumulated=${accumulated.gender} → latest=${latestExtracted.gender})`,
    );
    delete latestExtracted.gender;
  }

  // Subject-pivot reset. When the latest message names a NEW
  // subject (different gender from accumulated), the prior subject's
  // arch/overpronation/condition answers don't apply. Production
  // trace: grandma asked for self (Women + Medium arch + overpronation
  // yes) — bot resolved L220W. Then "how about for my 9 year old?" —
  // gate inherited the Medium arch + overpronation=yes and resolved
  // L1720Y (Kids Posted) using the WIFE'S overpronation answer. Same
  // for "and for my dad" — inherited wife's flat-feet posted state.
  // Customer kept screaming "he doesn't have flat feet" because every
  // subject's recommendation came from the wife's accumulated state.
  //
  // Reset condition + arch + overpronation when gender pivots. Keep
  // useCase (shoe context — "casual" tends to carry across subjects
  // if the customer didn't say otherwise). The kids-sticky case above
  // is already handled — if it fired, latestExtracted.gender is now
  // deleted so this check doesn't trigger.
  if (
    latestExtracted.gender &&
    accumulated.gender &&
    latestExtracted.gender !== accumulated.gender
  ) {
    console.log(
      `[orthotic-flow] subject pivot: gender ${accumulated.gender} → ${latestExtracted.gender}; ` +
        `dropping accumulated condition/arch/overpronation/useCase (subject-specific attrs)`,
    );
    delete accumulated.condition;
    delete accumulated.arch;
    delete accumulated.overpronation;
    // useCase was missed in the original pivot drop. Production trace:
    // customer browsed pink wedges for women (useCase=dress_no_removable
    // set), then asked an orthotic question — the gate kept the stale
    // dress useCase and resolved to the Fashion line instead of asking
    // what shoes the orthotic actually goes in. useCase is also a
    // subject-bound attribute: a different recipient is going to wear
    // their orthotic in different shoes.
    delete accumulated.useCase;
  }

  // Fresh arch claim invalidates stale overpronation. Without this,
  // a customer who said "flat feet" earlier (which set overpronation=yes)
  // and now starts a new question with "medium arch" ends up with both
  // arch=Medium/High AND overpronation=yes — the posted=true derivation
  // fires and the resolver picks a Flat/Low Arch product instead of
  // the Medium/High one the customer just named. Same trap in reverse:
  // a fresh overpronation claim should drop stale arch.
  //
  // Skip these resets when the latest message is a bare chip-shaped
  // answer (≤ 20 chars matching a known chip token: "Yes" / "No" /
  // "Not sure" / "Flat / Low" / "Medium" / "High" / "I don't know").
  // A short chip answer to the immediately preceding q_overpronation
  // question is NOT a topic pivot — it's the customer answering the
  // current question. Without this guard the reset drops the arch
  // the customer JUST picked, causing an infinite q_arch loop.
  const trimmedUser = rawUserText.trim();
  const isChipShapedReply =
    trimmedUser.length <= 20 &&
    /^(?:yes|no|not\s+sure|maybe|flat\s*\/?\s*low(?:\s+arch)?|medium(?:\s+arch)?|high(?:\s+arch)?|i\s+don'?t\s+know|i\s+dunno|unsure)\.?$/i.test(trimmedUser);
  if (
    !isChipShapedReply &&
    latestExtracted.arch &&
    accumulated.overpronation &&
    !latestExtracted.overpronation
  ) {
    console.log(
      `[orthotic-flow] fresh-arch reset: customer stated arch=${latestExtracted.arch}; ` +
        `dropping accumulated overpronation=${accumulated.overpronation}`,
    );
    delete accumulated.overpronation;
  }
  if (
    !isChipShapedReply &&
    latestExtracted.overpronation &&
    accumulated.arch &&
    !latestExtracted.arch
  ) {
    console.log(
      `[orthotic-flow] fresh-overpronation reset: customer stated overpronation=${latestExtracted.overpronation}; ` +
        `dropping accumulated arch=${accumulated.arch}`,
    );
    delete accumulated.arch;
  }

  // Customer-correction veto. The customer just pushed back on a
  // prior accumulated answer ("but he doesn't have flat feet" /
  // "actually she doesn't / no he doesn't"). Whatever we accumulated
  // is now suspect — fall through to the LLM, which can apologize
  // and re-elicit cleanly. Auto-resolving the same SKU after the
  // customer contradicted us is the worst customer-experience bug.
  const CORRECTION_RE = /^\s*(?:but|actually|no,?\s+(?:he|she|they|i))\b[^.!?]{0,80}?\b(?:doesn'?t|does not|don'?t|do not|isn'?t|is not|aren'?t|are not)\b/i;
  if (CORRECTION_RE.test(rawUserText)) {
    console.log(
      `[orthotic-flow] customer correction detected ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Subject-clarification veto. Customer is correcting the bot's
  // assumption that the orthotic is for THEM ("this is not for me",
  // "it's not for me", "i don't need this for me, i need it for my
  // brother"). Production trace 2026-05-10 16:01: bot kept emitting
  // q_arch three turns in a row while customer typed "this is not
  // for me" twice — the gate didn't recognize the redirect. Fall
  // through so the LLM can ack the subject and re-ask appropriately.
  // Match both "this is not for me" AND the contraction "this isn't for me"
  // (which has no space inside "isn't"). Earlier version required (?:is\s+)?
  // before "not" — that worked for the spaced form but missed the contraction.
  const SUBJECT_CLARIFICATION_RE = /\b(?:(?:this|it|that)(?:['‘’]?s)?\s+(?:(?:is|are)\s+not|isn['‘’]?t|aren['‘’]?t|ain['‘’]?t|not)\s+for\s+me|(?:i'?m|i\s+am)\s+not\s+the\s+(?:one|person)|i\s+don'?t\s+need\s+(?:this|it|one)\s+for\s+me|not\s+for\s+me[,.\s]+(?:for|it'?s|its)\b)/i;
  if (SUBJECT_CLARIFICATION_RE.test(rawUserText)) {
    console.log(
      `[orthotic-flow] subject clarification detected ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Meta-frustration veto. Customer is questioning whether the bot is
  // even paying attention ("are you listening?", "did you read what
  // i said?", "are you listing to me?" — typos welcome). Production
  // trace 2026-05-10 16:01: bot ignored two prior redirects, customer
  // typed "are you listeting to me?", bot emitted q_arch a THIRD
  // time. Fall through so the LLM can apologize and recover.
  const META_FRUSTRATION_RE = /\b(?:are\s+you\s+(?:list[a-z]*|hear[a-z]*|read[a-z]*|paying\s+attention|even\s+(?:list|read|hear))|did\s+you\s+(?:read|hear|listen|understand|see)\s+(?:what|me|that)|do\s+you\s+(?:even|actually)\s+understand|hello\?+\s*$|are\s+you\s+(?:there|alive|broken|stuck|a\s+(?:bot|robot)))/i;
  if (META_FRUSTRATION_RE.test(rawUserText)) {
    console.log(
      `[orthotic-flow] meta-frustration detected ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Give-up veto. Customer is fed up with the question chain and just
  // wants a result NOW ("ugh whatever just pick one", "you choose",
  // "just give me something", "i don't care"). Continuing the chip
  // chain after this signal feels like the bot ignoring the customer.
  // Fall through so the LLM can offer a sensible default or short-list.
  const GIVE_UP_RE = /\b(?:(?:ugh|fine|whatever)\b[^.!?]{0,30}?\b(?:just|pick|choose|give|whatever)|just\s+(?:pick|choose|give\s+me|show\s+me)\s+(?:one|something|anything)|you\s+(?:pick|choose|decide)|surprise\s+me|i\s+don'?t\s+care|doesn'?t\s+matter\s+(?:to\s+me)?|stop\s+asking)/i;
  if (GIVE_UP_RE.test(rawUserText)) {
    console.log(
      `[orthotic-flow] give-up signal detected ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Source-challenge / meta-question detection. When the customer
  // questions where a prior AI claim came from ("where did you get that
  // from?", "what's your source?", "you said X — where's that from?"),
  // the right answer is the LLM defending or retracting the claim — NOT
  // the gate seeding the next chip question. Customer is contesting,
  // not progressing through the funnel.
  //
  // Production trace 2026-05-11: AI said "customers swear by these
  // plantar fasciitis kits" → customer asked "you said 'swear by' —
  // where did you get that from?" → gate saw accumulated condition and
  // emitted q_gender ("Who are these orthotics for?"), totally
  // off-topic. Fix: skip the gate on this turn.
  const META_QUESTION_RE = /\b(?:where\s+(?:did|do)\s+you\s+(?:get|find|hear|read|see)\s+(?:that|this|it)|where\s+(?:does|did)\s+(?:that|this|it)\s+come\s+from|what(?:['‘’]?s| is)\s+your\s+source|how\s+do\s+you\s+know\s+(?:that|this)|who\s+told\s+you|what\s+(?:are|is)\s+you\s+basing\s+(?:that|this|it)\s+on|(?:any|got\s+a|got\s+any|cite\s+a|cite\s+any)\s+sources?|how\s+can\s+you\s+say\s+that|prove\s+it|(?:you|u)\s+(?:just\s+)?said\s+["“'‘]|(?:you|u)\s+(?:just\s+)?said\s+(?:that\s+)?(?:["“'‘]|customers|people|fans|users))/i;
  if (META_QUESTION_RE.test(rawUserText)) {
    console.log(
      `[orthotic-flow] meta-question / source challenge ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Domain disambiguation. When the customer mentions a clinical
  // condition + a generic shopping verb but no product noun ("I have
  // foot pain, what should I wear?"), the old regex intent stack used
  // to ask "footwear or orthotic?" before launching the orthotic chip
  // funnel. The Haiku classifier (4524e94) is more eager to commit to
  // orthotic on a bare condition, so customers who actually wanted
  // arch-support footwear get dragged through 5 chip turns and then
  // shown an orthotic that may or may not be in stock.
  //
  // Trigger: latest message has a condition hint AND a generic
  // shopping verb AND no footwear noun AND no orthotic noun.
  // Suppress: if the disambiguation has already been asked this
  // conversation (chip label present in any prior assistant turn).
  // Footwear nouns. `heels?` and `flats?` are intentionally absent —
  // they collide with anatomy/condition words ("heel pain", "flat
  // feet"). The customer who really means high heels says "heels" in
  // a different shape; if they typed "heel pain, what to wear" they
  // need the disambig anyway.
  const FOOTWEAR_NOUN_RE = /\b(shoes?|sandals?|sneakers?|boots?|loafers?|clogs?|slip[- ]ons?|mary[- ]janes?|wedges?|footwear|oxfords?|moccasins?|slippers?|trainers?|pumps?|mules?)\b/i;
  const ORTHOTIC_NOUN_RE = /\b(orthotics?|orhtotics?|orthtoics?|insoles?|inserts?|inner[- ]soles?|arch[- ]support[- ]insert|heel[- ]cups?|footbeds?|thinsoles?)\b/i;
  const SHOPPING_VERB_RE = /\b(wear|wears|wearing|recommend|recommendation|recommends|find|finding|looking[- ]for|want|wants|wanting|need|needs|needing|get|gets|getting|buy|buying|best|good|suitable|right|help\s+(?:me|with))\b/i;
  const CONDITION_HINT_RE = /\b(pain|aching?|sore|sores|fasciit(?:is|us)|bunions?|hammertoes?|neuroma|flat[- ]feet|high[- ]arch|low[- ]arch|overpronation|underpronation|plantar|metatarsal|heel[- ]spurs?|diabetic|diabetes|arthritis)\b/i;
  const DISAMBIG_CHIP_RE = /<<\s*Footwear\s+with\s+arch\s+support\s*>>|<<\s*Orthotic\s+insole\s*>>/i;
  const alreadyAsked = Array.isArray(messages) && messages.slice(0, -1).some((m) => {
    return m && m.role === "assistant" && typeof m.content === "string" && DISAMBIG_CHIP_RE.test(m.content);
  });
  const isConditionOnly = CONDITION_HINT_RE.test(rawUserText) &&
                          SHOPPING_VERB_RE.test(rawUserText) &&
                          !FOOTWEAR_NOUN_RE.test(rawUserText) &&
                          !ORTHOTIC_NOUN_RE.test(rawUserText);
  // Mid-orthotic-flow suppression. Production trace: customer was on
  // turn 4 of the orthotic flow (had answered condition + gender +
  // arch + overpronation chips), then asked "is this good for flat
  // feet and ball of foot pain?" — the disambig fired and asked
  // "footwear or orthotic?", which is absurd because they had ALREADY
  // chosen orthotic three turns earlier and were asking a follow-up
  // about the recommended product. Skip the disambig when the customer
  // has accumulated orthotic-flow answers (they've committed) OR the
  // prior assistant turn was an orthotic recommendation/seed question.
  const alreadyInOrthoticFlow =
    Object.keys(accumulated).length > 0 ||
    (Array.isArray(messages) && messages.slice(0, -1).some((m) => {
      if (!m || m.role !== "assistant" || typeof m.content !== "string") return false;
      return /\b(orthotic|insole|posted orthotic|train posted|comfort posted|plantar fasciitis kit)\b/i.test(m.content) ||
        /<<\s*(?:Flat\s*\/\s*Low|Medium|High)\b/i.test(m.content) ||
        /<<\s*(?:Walking|Dress|Athletic|Cleats|Winter|Work)\b/i.test(m.content);
    }));
  if (isConditionOnly && !alreadyAsked && !alreadyInOrthoticFlow) {
    const text =
      "Got it — sounds like you're dealing with some foot discomfort. " +
      "Are you looking for footwear with built-in arch support, or an " +
      "orthotic insole that goes inside your existing shoes?\n\n" +
      "<<Footwear with arch support>><<Orthotic insole>>";
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
    controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    console.log(
      `[orthotic-flow] domain disambig: condition-only query without product noun ` +
        `("${rawUserText.slice(0, 60)}"); asked footwear-vs-orthotic`,
    );
    return { handled: true };
  }

  const answers = { ...accumulated, ...latestExtracted };

  // Path-ambiguity disambig. When the customer earlier committed to
  // FOOTWEAR (picked "Footwear with arch support" from the domain
  // disambig, or said something like "find me sneakers") and the
  // current turn's classifier extracted an ortho-shaped useCase
  // (production trace 2026-05-12: customer said "heels" after
  // committing to footwear → classifier extracted useCase=
  // dress_no_removable → silent re-classification put them in the
  // orthotic flow). Rather than silently switching paths or trying
  // to override the classifier, ask the customer transparently:
  // "Just to make sure — are you looking for [X] to wear, or an
  // orthotic insole?" Their chip click definitively resolves it.
  //
  // M1.3: the previous "already asked" check scanned ASSISTANT
  // messages for `<<Orthotic insole for these>>` chip markup, but
  // the widget round-trip strips chip markers from history, so the
  // check evaluated to false on every subsequent turn and the
  // disambig fired repeatedly (Bug: it asked again after the
  // customer answered condition/arch/overpronation chips). Detect
  // resolution from the USER's chip ANSWERS instead — those round-
  // trip intact — and add two further suppressors:
  //   - LATEST_PATH_LOCK_CHOICE / ORTHOTIC_PATH_LOCKED_FLAG (B1/B2):
  //     customer already picked "Orthotic insole for these" → never
  //     ask path-ambig again in this conversation.
  //   - ACTIVE_ORTHOTIC_CHIP_ANSWER (Case A): the latest user
  //     message is itself an answer to an active orthotic-flow chip
  //     question (condition/arch/overpronation/useCase) → not the
  //     moment to disambiguate.
  const PATH_RESOLUTION_USER_RE = /^\s*(?:Orthotic insole for these|The shoes themselves|Heels to wear|Just shoes)\.?\s*$/i;
  const ORTHOTIC_LOCK_USER_RE = /^\s*Orthotic insole for these\.?\s*$/i;
  // Include the LATEST user message so the customer's path-lock
  // pick on THIS turn already counts (otherwise the gate would
  // ask path-ambig once more before noticing the resolution).
  const allUserMsgs = messages.filter((m) => m && m.role === "user" && typeof m.content === "string");
  const pathAlreadyResolvedByUser = allUserMsgs.some((m) => PATH_RESOLUTION_USER_RE.test(m.content));
  const orthoticPathLockedInHistory = allUserMsgs.some((m) => ORTHOTIC_LOCK_USER_RE.test(m.content));
  // Latest user message is an EXACT chip-label match for one of the
  // orthotic tree's non-gender questions (condition / arch /
  // overpronation / useCase). Distinguishes a true chip-click on an
  // active orthotic question from a keyword that happens to match
  // ("heels" → useCase keyword while still on footwear path).
  //
  // Note: an earlier attempt also accepted `latestExtracted.<attr>`
  // as a chip-exact signal, but that over-suppressed path-ambig when
  // a classifier hallucinated an orthotic-shaped attribute (e.g.
  // useCase=dress_no_removable from the customer saying "heels"
  // while on footwear path). Strict chip-label match is the right
  // signal here. Tree-label drift between the seed file and the
  // DB-stored tree (e.g. "Flat feet / Overpronation" with different
  // spacing/casing/punctuation) is fixed at the data layer.
  const latestIsOrthoticChipExact = (() => {
    if (!rawUserText || !tree?.definition?.nodes) return false;
    const norm = rawUserText.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!norm) return false;
    for (const node of tree.definition.nodes) {
      if (!node || node.type !== "question") continue;
      if (node.attribute === "gender") continue; // gender clicks are path-neutral
      if (!Array.isArray(node.chips)) continue;
      for (const chip of node.chips) {
        const lbl = String(chip?.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
        const val = String(chip?.value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
        if (lbl && norm === lbl) return true;
        if (val && norm === val) return true;
      }
    }
    return false;
  })();
  const ORTHOTIC_NOUN_RE_PATH = /\b(orthotics?|insoles?|inserts?|inner[- ]soles?|footbeds?|thinsoles?|heel[- ]cups?)\b/i;
  const footwearCommittedInHistory = Array.isArray(messages) && messages.slice(0, -1).some((m) => {
    if (!m || m.role !== "user" || typeof m.content !== "string") return false;
    // Customer picked "Footwear with arch support" from the domain
    // disambig chip — definitive commitment to footwear path.
    if (/^\s*Footwear with arch support\.?\s*$/i.test(m.content)) return true;
    // Or said something concrete like "find me sneakers".
    return looksLikeFootwearCommit(m.content);
  });
  const classifierSaysOrthoNow = !!(classifiedIntent && classifiedIntent.isOrthoticRequest);
  const latestHasOrthoticNoun = ORTHOTIC_NOUN_RE_PATH.test(rawUserText);
  if (
    !pathAlreadyResolvedByUser &&
    !orthoticPathLockedInHistory &&
    !latestIsOrthoticChipExact &&
    footwearCommittedInHistory &&
    classifierSaysOrthoNow &&
    !latestHasOrthoticNoun
  ) {
    // Use the customer's most recent footwear-shaped noun if it's in
    // their message; otherwise fall back to "the shoes you mentioned".
    const FOOTWEAR_NOUN_FOR_LABEL = /\b(heels?|sneakers?|sandals?|boots?|loafers?|clogs?|wedges?|oxfords?|moccasins?|slippers?|trainers?|pumps?|mules?|mary[- ]janes?|slip[- ]ons?)\b/i;
    const m = rawUserText.match(FOOTWEAR_NOUN_FOR_LABEL);
    const noun = m ? m[1].toLowerCase() : "those";
    const text =
      `Just to make sure I get this right — are you looking for ${noun} ` +
      `you can wear, or an orthotic insole to put in your ${noun}?\n\n` +
      `<<The shoes themselves>><<Orthotic insole for these>>`;
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
    controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    console.log(
      `[orthotic-flow] path-ambiguity disambig: customer committed to footwear earlier, ` +
        `current turn extracted ortho-shaped useCase=${classifiedIntent?.attributes?.useCase || "?"}; ` +
        `asking customer to clarify (transparent, customer-correctable)`,
    );
    return { handled: true, case: "F_path_ambig" };
  }

  // Kids auto-fill for useCase. When gender=Kids, the seed's q_use_case
  // chips (Dress shoes, Cleats, Skates, etc.) almost never have a
  // Kids-tagged SKU behind them — the merchant's Kids orthotic line
  // (L17xx) is a generic "kids" useCase that doesn't appear as a chip
  // label. Asking the customer to pick a shoe-type only sends them to
  // a dead-end. Instead: if the masterIndex has any Kids-tagged SKUs,
  // auto-fill answers.useCase to the first one (lex-sorted for
  // determinism) and skip the q_use_case question entirely. Customer
  // goes directly to q_condition. If they already picked a non-Kids
  // useCase via chip ("Cleats"), override it — Kids selection wins.
  if (isKidsGenderValue(answers.gender)) {
    const allowed = kidsAvailableUseCases(tree);
    if (!allowed || allowed.size === 0) {
      // Merchant's masterIndex has zero Kids-tagged SKUs. Don't lead
      // the customer through a chip flow that ends in "we don't carry
      // it" — fall through to the LLM, which can say so honestly in a
      // single message and offer alternatives. Logged so the merchant
      // can see they need to either tag products as Kids or remove
      // the Kids chip from their gender question.
      console.log(
        `[orthotic-flow] kids classifier-extracted but no Kids items in masterIndex; ` +
          `falling through to LLM`,
      );
      return { handled: false };
    }
    // ALWAYS override useCase to a kids-available value when
    // gender=Kids. The merchant's Kids line spans a few useCase
    // buckets (kids / dress / casual) and the customer's earlier-
    // mentioned shoe-context doesn't have a Kids SKU behind it.
    // Priority: prefer the literal "kids" useCase if available
    // (it's the merchant's general kids line, useCase-agnostic),
    // otherwise lex-first. The conversation eval caught the
    // alphabetical-sort picking "casual" over "kids".
    const target = allowed.has("kids") ? "kids" : [...allowed].sort()[0];
    if (answers.useCase !== target) {
      console.log(
        `[orthotic-flow] kids auto-fill: useCase=${answers.useCase || "(unset)"} → ${target} ` +
          `(kids-available=${[...allowed].join(",")})`,
      );
      answers.useCase = target;
    }
  }

  // Hard veto: customer explicitly rejected orthotics in their
  // latest message. Classifier-first; regex fallback only when the
  // classifier didn't run (network error etc).
  const rejected = classifiedIntent
    ? classifiedIntent.isRejection
    : hasOrthoticRejection(rawUserText);
  if (rejected) {
    return { handled: false };
  }

  // Off-topic side question mid-flow. If the classifier confidently
  // says the latest message is NEITHER orthotic NOR footwear (e.g.
  // 'are you a real person', 'what's your return policy', 'how long
  // does shipping take'), AND the latest message doesn't look like a
  // chip click, fall through to the LLM so it can answer the side
  // question. The next turn will resume the flow naturally.
  //
  // Without this, customers asking side questions mid-orthotic-flow
  // see the bot re-emit the chip question instead of answering them
  // — broken UX. The eval caught this on a 9-turn scenario.
  if (
    classifiedIntent &&
    classifiedIntent.isOrthoticRequest === false &&
    classifiedIntent.isFootwearRequest === false &&
    classifiedIntent.isRejection === false
  ) {
    // Check whether the latest message is a chip click (would map to
    // an attribute via preExtractAnswers). If so, the classifier is
    // wrong — the customer DID answer a chip — treat as in-flow.
    const latestExtractedCheck = preExtractAnswers(rawUserText, tree.definition);
    const isChipShaped = Object.keys(latestExtractedCheck).length > 0;
    if (!isChipShaped) {
      console.log(
        `[orthotic-flow] off-topic side question mid-flow (classifier: neither ortho nor footwear); falling through to LLM`,
      );
      return { handled: false };
    }
  }

  const priorAssistantHadChips = priorMessages.some(
    (m) => m && m.role === "assistant" && typeof m.content === "string" && /<<[^<>]+>>/.test(m.content),
  );

  // Availability / capability questions are answer requests, not
  // shopping-flow commitments. Ask/answer turns like "do you sell
  // shoes?", "do you carry sneakers?", or "do you have sandals?"
  // should reach the normal catalog/LLM path so it can say yes/no
  // and optionally show cards. Without this early veto, the
  // classifier's isFootwearRequest=true path below asks for gender
  // first, which feels like the bot ignored the question.
  if (
    looksLikeAvailabilityQuestion(rawUserText) &&
    !looksLikeRecommendationRequest(rawUserText) &&
    !priorAssistantHadChips
  ) {
    console.log(
      `[orthotic-flow] availability question before footwear gate ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM/catalog`,
    );
    return { handled: false };
  }

  // Hard veto #1: customer committed to the FOOTWEAR path — either
  // in the latest message or in a prior turn. Classifier-first; the
  // classifier returns isFootwearRequest=true when the customer is
  // shoe-shopping AND isOrthoticRequest=false. The latest-message
  // pivot rule (orthotic intent overrides prior footwear commit)
  // is implicit in the classifier's joint output.
  const intentInLatestForVeto = classifiedIntent
    ? classifiedIntent.isOrthoticRequest
    : detectOrthoticIntent(rawUserText);
  const footwearCommitInLatest = classifiedIntent
    ? classifiedIntent.isFootwearRequest
    : looksLikeFootwearCommit(rawUserText);
  const footwearCommitInPrior =
    !intentInLatestForVeto &&
    priorMessages.some(
      (m) =>
        m &&
        m.role === "user" &&
        typeof m.content === "string" &&
        looksLikeFootwearCommit(m.content),
    );
  if (footwearCommitInLatest || footwearCommitInPrior) {
    const softGenderGateEscape = shouldSoftEscapeFootwearGenderGate({
      messages: priorMessages,
      answers,
    });
    if (!answers.gender && softGenderGateEscape) {
      console.log(
        `[orthotic-flow] footwear-path gender soft escape: gender was asked ` +
          `${countGenderGateAsks(priorMessages)} time(s), latest="${rawUserText.slice(0, 60)}"; ` +
          `falling through to broad catalog browse`,
      );
      return {
        handled: false,
        case: "soft_gender_gate_escape",
        softGenderGateEscape: true,
      };
    }

    // BEFORE falling through to the LLM, enforce DISCOVERY ORDER:
    // gender must be asked before category. The prompt has a rule
    // for this ("DISCOVERY ORDER — GENDER BEFORE CATEGORY") but in
    // practice the LLM sometimes jumps straight to category when the
    // customer's footwear-commit happens via a chip answer to the
    // "Footwear or orthotic?" disambig — the LLM treats the chip as
    // a footwear request and skips ahead. Hard-force gender first.
    // Decorated gender chips ("<<Men's shoes>>") count as a prior
    // gender ask too — allow a trailing context noun in the marker.
    const GENDER_CHIP_RE = /<<\s*Men(?:['’]?s)?(?:\s+[^<>]*)?>>|<<\s*Women(?:['’]?s)?(?:\s+[^<>]*)?>>/i;
    const alreadyAskedGender = priorMessages.some(
      (m) =>
        m &&
        m.role === "assistant" &&
        typeof m.content === "string" &&
        GENDER_CHIP_RE.test(m.content),
    );
    if (!answers.gender && !alreadyAskedGender) {
      if (letsCatalogResolverOwnFootwearRequest(rawUserText)) {
        console.log(
          `[orthotic-flow] footwear-path: latest names catalog-specific footwear/color; ` +
            `falling through to catalog resolver before asking gender.`,
        );
        return { handled: false };
      }
      const text =
        "Got it — let me help you find the right fit. " +
        "Are you shopping for men's or women's?\n\n" +
        "<<Men's>><<Women's>>";
      controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
      controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
      controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
      console.log(
        `[orthotic-flow] footwear-path: gender unknown, asking gender first ` +
          `(prompt's discovery-order rule wasn't enough — hard gate).`,
      );
      return { handled: true };
    }
    console.log(
      `[orthotic-flow] footwear-path veto: customer committed to footwear ` +
        `(${footwearCommitInLatest ? "latest" : "prior"}); falling through to LLM`,
    );
    return { handled: false };
  }

  // Hard veto #2: latest message names a concrete non-orthotic
  // footwear product (shoes, sandals, sneakers, boots, loafers,
  // oxfords, slippers, clogs, mary janes, trainers, footwear,
  // wedges, heels, flats, pumps, mules). Production showed
  // "best summer sandal for a beach for my mom" slipping past
  // looksLikeFootwearCommit (no find/show/need/want trigger word)
  // and engaging the orthotic flow because Layer 2 picked gender=
  // Women from "for my mom". Catching the product noun directly
  // is more robust than enumerating phrasings.
  //
  // BUT only apply this when no orthotic intent is already
  // established in history. Once a customer has said "I need
  // orthotics" earlier in the conversation, their later messages
  // ARE expected to mention footwear nouns — they're answering
  // questions like "What kind of shoes will the orthotics go in?"
  // with chip values like "Everyday / casual shoes". Without this
  // intent-history bypass, the veto would catch chip clicks and
  // bump the customer out of mid-flow. Equivalent guard already
  // lives inside looksLikeFootwearCommit via detectOrthoticIntent
  // for the latest message; the history-level intent check covers
  // the multi-turn case.
  const intentAnywhereInHistory =
    intentInLatestForVeto ||
    priorMessages.some(
      (m) => m && m.role === "user" && typeof m.content === "string" &&
        detectOrthoticIntent(m.content),
    );
  if (!intentAnywhereInHistory && mentionsNonOrthoticFootwear(rawUserText)) {
    console.log(
      `[orthotic-flow] non-orthotic-footwear veto: latest names a footwear ` +
        `product without orthotic intent; falling through to LLM`,
    );
    return { handled: false };
  }

  // Hard veto #3 — conversation-level footwear commitment. Runs
  // before BOTH bootstrap and engagement/continuation firing below.
  //
  // Production hijack 2026-06-12: turn 1 "I have plantar fasciitis
  // and going on a trip to Italy, what shoes do you recommend?"
  // correctly fell through to the LLM (footwear request), the LLM
  // asked men's/women's, and the customer clicked "Women's". The
  // bare chip answer carries no footwear noun, so neither hard veto
  // #1 nor #2 fired (#1's prior-commit scan is also disabled when
  // the classifier tags the chip turn as orthotic, and turn 1's
  // condition mention suppresses looksLikeFootwearCommit /
  // mentionsNonOrthoticFootwear per-message anyway). The engagement
  // rule then fired on accumulated condition+gender and the gate
  // emitted q_use_case — hijacking a customer who asked for SHOES
  // and never expressed orthotic intent.
  //
  // Rule: if any PRIOR user message committed to footwear and no
  // SUBSEQUENT user message (including the latest) pivoted to
  // orthotic intent, the gate falls through to the LLM — even on
  // chip-answer turns. A later orthotic pivot ("Orthotic insole for
  // these", "actually I need inserts", a condition restated with
  // orthotic words) re-opens the flow.
  //
  // Weak commits (a footwear noun / recommendation ask without an
  // explicit "find me sneakers" shape) are ignored when the message
  // is answering an active orthotic question — an exact seed chip
  // label ("Dress shoes / heels") or any reply to an assistant turn
  // that itself talks about orthotics ("What kind of shoes will the
  // orthotics go in?"). Strong commits count regardless: "actually
  // just show me sneakers" mid-flow IS the customer leaving.
  {
    const stripForChipMatch = (s) =>
      String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    const isExactOrthoticChipLabel = (text) => {
      const norm = stripForChipMatch(text);
      if (!norm || !Array.isArray(tree?.definition?.nodes)) return false;
      const contextNoun = getGenderChipContextNoun(tree.definition);
      for (const node of tree.definition.nodes) {
        if (!node || node.type !== "question" || !Array.isArray(node.chips)) continue;
        for (const chip of node.chips) {
          const lbl = stripForChipMatch(chip?.label);
          const val = stripForChipMatch(chip?.value);
          if ((lbl && norm === lbl) || (val && norm === val)) return true;
          // Gender chips are emitted decorated ("Women's orthotics");
          // accept the decorated label as a seed chip answer too.
          if (node.attribute === "gender") {
            const dec = stripForChipMatch(decorateGenderChipLabel(chip?.label, contextNoun));
            if (dec && norm === dec) return true;
          }
        }
      }
      return false;
    };
    const ORTHOTIC_CONTEXT_ASSISTANT_RE =
      /\b(orthotics?|insoles?|inserts?|inner[- ]soles?|footbeds?|thinsoles?|heel[- ]cups?|arch\s+type|ankles\s+roll\s+inward)\b/i;
    const seedQuestionTexts = (tree?.definition?.nodes || [])
      .filter((n) => n && n.type === "question" && typeof n.question === "string" && n.question.trim())
      .map((n) => n.question.trim());
    const assistantTurnIsOrthoticContext = (text) => {
      if (typeof text !== "string" || !text.trim()) return false;
      if (ORTHOTIC_CONTEXT_ASSISTANT_RE.test(text)) return true;
      return seedQuestionTexts.some((q) => text.includes(q));
    };

    let lastFootwearCommitIdx = -1;
    let lastOrthoticPivotIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || m.role !== "user" || typeof m.content !== "string") continue;
      // Commit detection first: a message that asks for shoes wins as
      // a commit even when it also names a condition (the incident's
      // turn 1 is detectOrthoticIntent-true via "plantar fasciitis"
      // yet is unambiguously a footwear request). Latest message is
      // excluded — latest-turn commits are hard vetoes #1/#2's job.
      const commit = i < messages.length - 1 ? messageCommitsToFootwear(m.content) : false;
      if (commit === "strong") {
        lastFootwearCommitIdx = i;
        continue;
      }
      if (commit === "weak") {
        const answeringOrthoticQuestion = (() => {
          if (isExactOrthoticChipLabel(m.content)) return true;
          for (let j = i - 1; j >= 0; j--) {
            const prev = messages[j];
            if (prev && prev.role === "assistant" && typeof prev.content === "string") {
              return assistantTurnIsOrthoticContext(prev.content);
            }
          }
          return false;
        })();
        if (!answeringOrthoticQuestion) {
          lastFootwearCommitIdx = i;
          continue;
        }
      }
      if (messagePivotsToOrthotic(m.content)) {
        lastOrthoticPivotIdx = i;
      }
    }
    // A latest turn that is EXACTLY one of the flow's chip labels is
    // the customer actively answering the questionnaire — a stale
    // footwear commit earlier in a mixed conversation must not kill
    // the flow mid-answer (the bare chip carries no orthotic noun, so
    // it can't register as a pivot and the watermark comparison alone
    // would veto it).
    const latestHistoryMsg = messages[messages.length - 1];
    const latestIsFlowChipAnswer =
      latestHistoryMsg &&
      latestHistoryMsg.role === "user" &&
      typeof latestHistoryMsg.content === "string" &&
      isExactOrthoticChipLabel(latestHistoryMsg.content);
    if (
      lastFootwearCommitIdx >= 0 &&
      lastOrthoticPivotIdx <= lastFootwearCommitIdx &&
      !latestIsFlowChipAnswer
    ) {
      console.log(
        `[orthotic-flow] footwear-commit veto (history): customer committed to footwear ` +
          `on a prior turn and never pivoted; falling through to LLM`,
      );
      return { handled: false, case: "footwear_commit_history" };
    }
  }

  // Off-topic + chip-fingerprint detection upfront — both are used
  // by the engagement rule below.
  const lastAssistant = [...priorMessages].reverse().find((m) => m.role === "assistant");
  const lastAssistantText = lastAssistant && typeof lastAssistant.content === "string"
    ? lastAssistant.content
    : "";
  const fingerprintNode = lastAssistantText && /<<[^<>]+>>/.test(lastAssistantText)
    ? findNodeByChipsInText(lastAssistantText, tree.definition)
    : null;

  // Classifier-first intent check. Haiku reads the entire trimmed
  // history and decides whether the customer is asking for an
  // orthotic — so intentInLatest already incorporates the history
  // signal. We still scan priorMessages for legacy regex on
  // classifier-failure paths.
  const intentInLatest = classifiedIntent
    ? classifiedIntent.isOrthoticRequest
    : detectOrthoticIntent(rawUserText);
  const intentInHistory =
    intentInLatest ||
    priorMessages.some(
      (m) =>
        m &&
        m.role === "user" &&
        typeof m.content === "string" &&
        detectOrthoticIntent(m.content),
    );
  const haveAccumulated = Object.keys(accumulated).length > 0;

  // Engagement rule. The customer must EITHER have expressed clear
  // orthotic intent at some point in the conversation, OR be on a
  // recognized seed question (fingerprintNode) — accumulated answers
  // alone are NOT enough.
  //
  // Production scenario this rule fixes: customer browses sneakers
  // and sandals across several turns. Layer 2 incidentally picks up
  // gender=Women from "for my mom" or pronouns. Accumulated answers
  // grow without any orthotic context. Then the customer asks for a
  // sandal — and the gate would have engaged purely because
  // haveAccumulated was true. With this rule it does not, since
  // intentInHistory stays false on a footwear-only conversation.
  if (!intentInHistory && !fingerprintNode) {
    return { handled: false };
  }
  if (fingerprintNode && isOffTopicReply(rawUserText, fingerprintNode)) {
    console.log(
      `[orthotic-flow] off-topic reply on ${fingerprintNode.id} ("${rawUserText.slice(0, 40)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // If the latest message didn't already give us the current
  // node's answer via Layer 1/2, try Layer 3 (constrained Haiku
  // call) as a last sync-mappable resort. Only worth doing when we
  // have a reliable currentNode handle from the chip fingerprint.
  let layer3Attempted = false;
  let layer3Mapped = false;
  if (
    fingerprintNode &&
    fingerprintNode.attribute &&
    answers[fingerprintNode.attribute] === undefined
  ) {
    const askLLM = anthropic && haikuModel ? makeLayer3Hook(anthropic, haikuModel) : null;
    layer3Attempted = true;
    const mapped = await mapAnswerToEnum(
      rawUserText,
      fingerprintNode,
      tree.definition,
      askLLM ? { askLLM } : {},
    );
    if (mapped && mapped.value !== null && mapped.value !== undefined) {
      answers[fingerprintNode.attribute] = mapped.value;
      layer3Mapped = true;
      console.log(
        `[orthotic-flow] layer-${mapped.layer} mapped ${fingerprintNode.id} → ` +
          `${fingerprintNode.attribute}=${mapped.value}`,
      );
    }
  }

  // If the chip fingerprint was the ONLY engagement signal (no
  // prior intent, no prior accumulated answers, no Layer-1/2 hit
  // on the latest message) AND mapping the latest reply to that
  // current node failed across all layers, the customer's reply is
  // off-topic / unmappable for that question. Yield to the LLM —
  // emitting the next seed question would feel like a non-sequitur.
  if (
    fingerprintNode &&
    !intentInHistory &&
    !haveAccumulated &&
    Object.keys(latestExtracted).length === 0 &&
    layer3Attempted &&
    !layer3Mapped
  ) {
    console.log(
      `[orthotic-flow] reply on ${fingerprintNode.id} unmappable across layers; falling through to LLM`,
    );
    return { handled: false };
  }

  // Mid-flow question that doesn't answer the asked chip. The prior
  // assistant turn offered chips (fingerprintNode set), but THIS reply
  // is a question and did NOT provide the attribute that chip asked
  // for. Re-emitting the same chip would ignore the customer's actual
  // question — the dominant "repetitive" / "ignores-user" failure from
  // the adversarial hunter ("oh nice, can you tell me more about
  // those? do they come with arch support?" → bot re-asked the
  // diagnostic). Fall through to the LLM so it can answer, then
  // re-prompt naturally.
  //
  // Precise + safe: gated on (a) the reply NOT answering the asked
  // attribute (so "women's, but what about arch?" still advances —
  // gender was answered), and (b) a real question signal ("?" anywhere,
  // or an info/availability cue) so keep-alives ("ok", "next") and
  // gibberish still re-ask. Recommendation requests are excluded (they
  // resolve, not fall through).
  if (fingerprintNode) {
    const askedAttr = fingerprintNode.attribute;
    const answeredAsked =
      askedAttr &&
      (latestExtracted[askedAttr] !== undefined ||
        (layer3Mapped && answers[askedAttr] !== undefined));
    const looksLikeQuestion =
      /\?/.test(rawUserText) ||
      looksLikeInformationalQuestion(rawUserText) ||
      looksLikeAvailabilityQuestion(rawUserText);
    if (
      !answeredAsked &&
      looksLikeQuestion &&
      !looksLikeRecommendationRequest(rawUserText)
    ) {
      console.log(
        `[orthotic-flow] mid-flow question doesn't answer asked chip ` +
          `(${askedAttr || "?"}): "${rawUserText.slice(0, 60)}"; falling through to LLM`,
      );
      return { handled: false };
    }
  }

  // Informational-question mid-flow veto. The customer IS engaged in
  // orthotic flow (intentInHistory or fingerprintNode), but THIS turn
  // is asking what something IS / how it works / what its specs are
  // — not answering a chip and not requesting a recommendation. The
  // LLM (with RAG knowledge) is the right path. Without this veto:
  //
  //   - With full attrs already accumulated, gate walks to resolve
  //     and emits a phantom card on questions like "what is
  //     thinsole?" — production trace bug.
  //   - With partial attrs, gate emits the next chip question on
  //     unrelated info questions like "tell me about the L620" —
  //     bad UX.
  //
  // Bypass conditions (don't fire the veto):
  //   - Latest message extracted a new attribute → it's a chip
  //     answer, not an info question.
  //   - Layer 3 mapped the reply onto the fingerprint chip → also a
  //     chip answer.
  //   - Prior assistant message had chip syntax (fingerprintNode is
  //     set) → customer might be answering the chip question with an
  //     info-shaped reply ("yes, but how does this work?"). Defer.
  if (
    looksLikeInformationalQuestion(rawUserText) &&
    !looksLikeRecommendationRequest(rawUserText) &&
    Object.keys(latestExtracted).length === 0 &&
    !layer3Mapped &&
    !fingerprintNode
  ) {
    console.log(
      `[orthotic-flow] informational question mid-flow ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Availability-question mid-flow veto. Customer asked "do you have
  // X / do you carry Y / are there any Z" — a yes/no availability
  // question. Gate would otherwise emit the next chip question
  // ("What's your arch type?") on every turn, looping. The LLM must
  // answer yes/no with cards (or honest denial).
  //
  // NOTE: unlike the informational-question veto above, this one
  // does NOT require empty latestExtracted. The phrase "do you have
  // kids orthotics?" legitimately extracts useCase=kids via the
  // attribute pre-extractor — but the customer's INTENT is yes/no
  // availability, not a chip-flow continuation. The chip flow can
  // resume on the next turn if the customer wants to refine.
  // The fingerprintNode check still applies — if the prior assistant
  // message was a chip question, the customer might be answering it
  // with an info-shaped reply (e.g. "yes, but do you have kids?"),
  // and we defer to the chip-mapping logic.
  if (
    looksLikeAvailabilityQuestion(rawUserText) &&
    !looksLikeRecommendationRequest(rawUserText) &&
    !fingerprintNode
  ) {
    console.log(
      `[orthotic-flow] availability question mid-flow ("${rawUserText.slice(0, 60)}"); ` +
        `falling through to LLM`,
    );
    return { handled: false };
  }

  // Pick the next question node by `requiredAttributes` order rather
  // than following the seed's `next` chain. This guarantees gender
  // is always asked first, then useCase, then condition — regardless
  // of how the merchant's DB-stored tree happens to be wired (the
  // canonical seed file says gender-first but older DB copies may
  // still chain useCase → gender → condition). When all required
  // attributes are filled, fall through to the seed's node chain so
  // the resolve step at the end still fires.
  const required = Array.isArray(tree.definition?.requiredAttributes)
    ? tree.definition.requiredAttributes.filter((s) => typeof s === "string")
    : [];
  let currentNodeId = null;
  for (const attr of required) {
    if (answers[attr] !== undefined) continue;
    const candidate = (tree.definition?.nodes || []).find(
      (n) => n && n.type === "question" && n.attribute === attr,
    );
    if (candidate) {
      currentNodeId = candidate.id;
      break;
    }
  }
  // All required attrs are filled (or no requiredAttributes defined):
  // walk the seed chain from root, skipping past answered nodes,
  // until we land on the resolve step.
  if (!currentNodeId) {
    const root = getRootNode(tree.definition);
    if (!root) return { handled: false };
    currentNodeId = root.id;
    for (let i = 0; i < 16; i++) {
      const node = findNodeById(tree.definition, currentNodeId);
      if (!node || node.type !== "question") break;
      if (!node.attribute || answers[node.attribute] === undefined) break;
      const nextId = nextNodeFromTransition(node, answers[node.attribute]);
      if (!nextId) break;
      currentNodeId = nextId;
    }
  }

  const state = { currentNodeId, answers, unmappedTurns: 0 };
  const step = resolveSkippableSteps(state, tree.definition);

  if (step.type === "question") {
    // Note: there used to be a "stuck-loop" detector here that fired
    // when the same question was asked twice in a row. It was too
    // aggressive — false-positives on legitimate corrections, fragment
    // answers, and "ok / next / go on" keep-alives. Removed.
    //
    // The production trace that motivated it ('knee pain' loop) is
    // now handled at the classifier level: the classifier prompt
    // explicitly maps non-foot pain (knee/back/hip) to
    // condition='none' so the resolver picks a general orthotic
    // and the flow advances.

    const text = renderQuestionText(step.node, answers, tree, {
      latestExtracted,
      rawUserText,
    });
    if (!text) return { handled: false };
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text })));
    controller.enqueue(encoder.encode(sseChunk({ type: "products", products: [] })));
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    console.log(
      `[orthotic-flow] emitted seed question ${step.node.id} (${step.node.attribute}); ` +
        `answers=${Object.keys(answers).length} (${describeAnswers(answers)}); bypassed LLM`,
    );
    return { handled: true };
  }

  if (step.type === "resolve") {
    // Resolve-intent guard. Don't auto-emit a card just because all
    // required attributes happen to be filled from earlier turns. The
    // bug this fixes: customer says "what is thinsole?" mid-flow with
    // gender/useCase/condition already accumulated. Without this
    // guard, the gate walks straight to resolve and emits the same
    // phantom SKU card on every ortho-tagged turn — customer asked an
    // informational question, gets a product card, never learns what
    // a Thinsole is.
    //
    // Only auto-resolve when ONE of these is true:
    //   (a) The customer just answered a chip — fingerprintNode is
    //       set AND this turn produced a Layer-1/2/3 mapping. The
    //       last assistant message offered chip buttons and the
    //       customer answered them.
    //   (b) The latest message extracted at least one new attribute.
    //       Customer is providing the missing piece. (This subsumes
    //       (a) for most cases, but kept separate for clarity.)
    //   (c) The latest message is an explicit recommendation request
    //       ("show me / recommend / find me one / I'll take it / go
    //       ahead / sounds good / let's do it").
    //
    // OVERRIDE: if the message looks like an informational question
    // ("what is X / explain Y / tell me about Z"), fall through even
    // if (b) or (c) match. The customer's intent is to learn, not
    // to buy. A subsequent "yes, recommend one" can re-trigger.
    //
    // Otherwise: fall through to LLM. The LLM still has the
    // recommend_orthotic tool and can call it when it judges that's
    // what the customer actually wants.
    const justAnsweredChip =
      !!fingerprintNode && (Object.keys(latestExtracted).length > 0 || layer3Mapped);
    const completedAttrThisTurn = Object.keys(latestExtracted).length > 0;
    const explicitRecRequest = looksLikeRecommendationRequest(rawUserText);
    const informationalQuestion = looksLikeInformationalQuestion(rawUserText);
    const functionalQuestion = looksLikeFunctionalQuestion(rawUserText);
    // Transactional / ordering intent on a follow-up turn must NOT
    // re-trigger auto-resolve. Customer is past the recommendation
    // and asking how to buy — the LLM answers that with cart/support
    // info. UNLESS it IS an explicit recommendation request ("I'll
    // take it" + "show me one") — in that case the recommendation
    // path still wins.
    const transactionalQuestion =
      looksLikeTransactionalQuestion(rawUserText) && !explicitRecRequest;
    const hasResolveSignal =
      (justAnsweredChip || completedAttrThisTurn || explicitRecRequest) &&
      !informationalQuestion &&
      !functionalQuestion &&
      !transactionalQuestion;
    if (!hasResolveSignal) {
      console.log(
        `[orthotic-flow] resolve held: full attrs but no recommendation signal in latest turn ` +
          `("${rawUserText.slice(0, 60)}"); ` +
          `informational=${informationalQuestion}, functional=${functionalQuestion}, ` +
          `transactional=${transactionalQuestion}, ` +
          `justAnsweredChip=${justAnsweredChip}, completedAttr=${completedAttrThisTurn}, ` +
          `explicitReq=${explicitRecRequest}; falling through to LLM`,
      );
      return { handled: false };
    }

    const conversationText = messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    let result = await executeRecommenderTool({
      toolName: `recommend_${ORTHOTIC_INTENT}`,
      input: step.attrs,
      shop,
      trees: [tree],
      conversationText,
      latestUserText: rawUserText,
    });
    // Kids safety-net retry. If the first resolve fails for a Kids
    // customer, force useCase to the first kids-available value
    // and try again. The auto-fill above SHOULD prevent ever
    // reaching here with a non-kids useCase, but production has
    // shown cases where it didn't fire (stale data, edge cases),
    // and the failure mode is brutal — customer dead-ends after a
    // 4-question form. This retry is defense-in-depth: if a Kids
    // customer reaches here unresolved, force the kids line and
    // try once more.
    if (
      (result?.error || !result?.product) &&
      isKidsGenderValue(step.attrs?.gender)
    ) {
      const kidsAllowed = kidsAvailableUseCases(tree);
      if (kidsAllowed && kidsAllowed.size > 0) {
        const kidsTarget = kidsAllowed.has("kids")
          ? "kids"
          : [...kidsAllowed].sort()[0];
        if (step.attrs.useCase !== kidsTarget) {
          console.log(
            `[orthotic-flow] kids resolve retry: useCase=${step.attrs.useCase || "(unset)"} → ${kidsTarget}`,
          );
          const retryAttrs = { ...step.attrs, useCase: kidsTarget };
          const retry = await executeRecommenderTool({
            toolName: `recommend_${ORTHOTIC_INTENT}`,
            input: retryAttrs,
            shop,
            trees: [tree],
            conversationText,
            latestUserText: rawUserText,
          });
          if (retry?.product) {
            result = retry;
            step.attrs = retryAttrs;
          }
        }
      }
    }
    if (result?.error || !result?.product) {
      console.log(
        `[orthotic-flow] resolve failed (${result?.error || "no product"}); falling through to LLM`,
      );
      return { handled: false };
    }
    const card = formatRecommenderCard(result.product);
    if (!card) {
      console.log(
        `[orthotic-flow] resolved sku=${result.masterSku} but card formatting failed; falling through to LLM`,
      );
      return { handled: false };
    }
    const intro = buildResolveIntro(result, step.attrs);
    controller.enqueue(encoder.encode(sseChunk({ type: "text", text: intro })));
    controller.enqueue(encoder.encode(sseChunk({
      type: "products",
      products: [card],
    })));
    // Auto-generated storefront search CTA below the resolved orthotic
    // card. Built from the customer's resolved gender + the implicit
    // "orthotics" category. Emits nothing if storefrontSearchUrlPattern
    // is empty (default), preserving back-compat for shops that
    // haven't opted in.
    if (storefrontSearchUrlPattern || (Array.isArray(ctaOverrides) && ctaOverrides.length > 0)) {
      const lastUserText = (() => {
        for (let i = (messages || []).length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m?.role === "user" && typeof m.content === "string") return m.content;
        }
        return "";
      })();
      const auto = buildStorefrontSearchCTA({
        pattern: storefrontSearchUrlPattern,
        overrides: ctaOverrides,
        gender: step.attrs?.gender || answers?.gender || "",
        category: "orthotics",
        latestUserMessage: lastUserText,
        intent: "orthotic",
      });
      if (auto) {
        controller.enqueue(encoder.encode(sseChunk({
          type: "link",
          url: auto.url,
          label: auto.label,
        })));
      }
    }
    controller.enqueue(encoder.encode(sseChunk({ type: "done" })));
    console.log(
      `[orthotic-flow] resolved → ${result.masterSku} (${result.title}); ` +
        `answers=${describeAnswers(answers)}; emitted card; bypassed LLM`,
    );
    return { handled: true };
  }

  console.log(`[orthotic-flow] unexpected step type=${step.type}; falling through`);
  return { handled: false };
}

function describeAnswers(answers) {
  const entries = Object.entries(answers || {});
  if (entries.length === 0) return "(none)";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

function buildResolveIntro(result, attrs) {
  const title = String(result?.title || "this orthotic").trim();
  return `Based on what you've shared, **${title}** is the best match.`;
}

// Build a Layer 3 LLM hook bound to the given Anthropic client +
// model id. The hook signature matches what mapAnswerToEnum expects:
// `async (rawAnswer, node, tree) => { value }`. Returns null on
// errors so the orchestrator can fall through cleanly.
function makeLayer3Hook(anthropic, model) {
  return async function askLLM(rawAnswer, node /* , tree */) {
    const prompt = buildConstrainedAnswerPrompt(rawAnswer, node);
    if (!prompt) return { value: null };
    try {
      const res = await anthropic.messages.create({
        model,
        max_tokens: 80,
        messages: [{ role: "user", content: prompt }],
      });
      const text = res?.content?.[0]?.text || "";
      const value = parseConstrainedAnswerResponse(text, node);
      return { value };
    } catch (err) {
      // Re-throw so mapAnswerToEnum's catch records it as
      // layer="llm-error" — caller (gate) treats that as unmapped.
      throw err;
    }
  };
}
