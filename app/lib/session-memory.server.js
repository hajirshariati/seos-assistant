// Keyed session memory (Milestone 2).
//
// Per-turn, in-memory context ledger derived from conversation
// history, chip answers, latest user text, classifier output, and
// resolver state. Replaces the M1 placeholder where chat.jsx
// passed an empty `sessionMemory.explicit` to the resolver and only
// surfaced `sessionGender`. The recommender flow still uses its own
// tree-aware `accumulateAnswers` walk — this module surfaces the
// same scope as keyed facts to the resolver + LLM prompt.
//
// Privacy posture: scope is reconstructed every turn from the
// already-in-memory conversation. Nothing is persisted to disk or
// to any datastore beyond the current request.
//
// Shape:
//   {
//     explicit: {
//       gender, category, color, size, width,
//       condition, useCase, arch, overpronation,
//       specificProduct, rejectedCategories: []
//     },
//     inferred: { ... },              // from resolver
//     stale:    { ... },              // moved aside by a subject pivot
//     facts:    [{ key, value, source, turnIndex, confidence }],
//   }
//
// Rules implemented:
//   1. Latest explicit user statement wins.
//   2. Chip answers map to keyed facts (no answeredChoices array).
//   3. Subject pivots clear stale subject-specific facts.
//      - gender word changes (women → men, men → women, kids → women)
//      - recipient phrasing ("for my wife", "for my dad", "for my kid")
//   4. Generic follow-ups inherit prior scope by virtue of carryover.
//   5. Rejections persist until overridden (`rejectedCategories`).
//   6. No durable storage.

import { extractUserConstraints } from "./catalog-resolver.server.js";
import { detectRejectedCategories } from "./chat-postprocessing.js";
import { extractChoiceEvents } from "./choice-events.server.js";
import { detectStorefrontSearchModifier } from "./storefront-search-cta.server.js";
import { resolveTurnIntent } from "./turn-intent.server.js";

const SCALAR_KEYS = [
  "gender", "category", "color", "size", "width",
  "condition", "useCase", "arch", "overpronation",
  "specificProduct", "modifier", "badge", "onSale",
];

// Scope that is owned by a specific gender. Kept for recipient-
// without-gender handling (e.g. "for my partner") which is a
// separate signal from the linguistic pivot detection in
// turn-intent and reads off this list to stale-move subject scope.
const SUBJECT_PIVOT_KEYS = [
  "category", "color", "size", "width",
  "condition", "useCase", "arch", "overpronation",
  "specificProduct", "modifier", "badge", "onSale",
];

// Recipient → gender heuristic. The mapping is deliberately
// conservative — "partner", "friend", "coworker", "spouse" don't
// imply a gender, so they reset scope without setting one.
const RECIPIENT_RE =
  /\b(?:for|gift\s+for|shopping\s+for|to\s+buy\s+for|my)\s+(wife|husband|partner|girlfriend|boyfriend|spouse|mom|mother|dad|father|son|daughter|child|kid|kids|grandma|grandpa|grandmother|grandfather|grandson|granddaughter|nephew|niece|sister|brother|aunt|uncle|friend|coworker)\b/i;

const RECIPIENT_TO_GENDER = {
  wife: "women", girlfriend: "women", mom: "women", mother: "women",
  grandma: "women", grandmother: "women", sister: "women", aunt: "women",
  husband: "men", boyfriend: "men", dad: "men", father: "men",
  grandpa: "men", grandfather: "men", brother: "men", uncle: "men",
  son: "kids", daughter: "kids", grandson: "kids", granddaughter: "kids",
  nephew: "kids", niece: "kids", child: "kids", kid: "kids", kids: "kids",
  // Unknown / ambiguous → null. Caller treats null as "no gender
  // inference but a possible subject reset."
  partner: null, spouse: null, friend: null, coworker: null,
};

function detectRecipient(text) {
  if (!text) return { matched: false, gender: null };
  const m = RECIPIENT_RE.exec(text);
  if (!m) return { matched: false, gender: null };
  const word = m[1].toLowerCase();
  return { matched: true, gender: RECIPIENT_TO_GENDER[word] ?? null };
}

// Lightweight size + width extraction. Conservative — only fires on
// explicit cues so a bare "9" or "wide leg" doesn't accidentally
// resolve.
function detectSizeWidth(text) {
  const out = {};
  if (!text || typeof text !== "string") return out;
  // "11W" / "10.5W" — combined size+width token.
  let m = text.match(/\b(\d{1,2}(?:\.\d|½)?)\s*(W|N|M)\b/i);
  if (m) {
    out.size = `${m[1]}${m[2].toUpperCase()}`;
    out.width = m[2].toUpperCase() === "W" ? "wide" : m[2].toUpperCase() === "N" ? "narrow" : "medium";
    return out;
  }
  // "wide sizes" / "wide width" / "in wide" / "narrow"
  m = text.match(/\b(wide(?:[\s-]+(?:width|widths|sizes?|fit))?|narrow|medium(?:[\s-]+width)?)\b/i);
  if (m) {
    const w = m[1].toLowerCase();
    if (w.startsWith("wide")) out.width = "wide";
    else if (w.startsWith("narrow")) out.width = "narrow";
    else if (w.startsWith("medium")) out.width = "medium";
  }
  // "size 9" / "size 9.5"
  m = text.match(/\bsize\s+(\d{1,2}(?:\.\d|½)?)\b/i);
  if (m) out.size = m[1];
  return out;
}

function detectMerchandisingScope(text) {
  const modifier = detectStorefrontSearchModifier(text);
  if (!modifier) return {};
  const out = { modifier };
  if (modifier === "new") out.badge = "new";
  else if (modifier === "bestseller") out.badge = "best";
  else if (modifier === "sale") out.onSale = true;
  return out;
}

const ORTHOTIC_WORD_RE = /\b(?:orthotics?|orthotic\s+insoles?|insoles?|inserts?)\b/i;
const SHOE_WORD_RE = /\b(?:shoes?|footwear)\b/i;
const FOOTWEAR_BEFORE_ORTHOTICS_RE =
  /\b(?:supportive\s+(?:shoes?|footwear)\s+first|(?:try|start\s+with|look\s+at|find)\s+(?:supportive\s+)?(?:shoes?|footwear)\s+first|rather\s+(?:try|start\s+with)\s+(?:supportive\s+)?(?:shoes?|footwear)|before\s+(?:going\s+)?(?:that\s+route|orthotics?|orthotic\s+insoles?|insoles?|inserts?)|not\s+(?:ready\s+for\s+)?(?:orthotics?|orthotic\s+insoles?|insoles?|inserts?))\b/i;

function prefersFootwearBeforeOrthotics(text) {
  const value = String(text || "");
  return ORTHOTIC_WORD_RE.test(value)
    && SHOE_WORD_RE.test(value)
    && FOOTWEAR_BEFORE_ORTHOTICS_RE.test(value);
}

function moveExplicitToStale(memory, key) {
  if (memory?.explicit?.[key] == null) return;
  memory.stale[key] = memory.explicit[key];
  delete memory.explicit[key];
}

function normalizeMerchandisingScope(memory, extracted) {
  const modifier = extracted?.modifier || memory?.explicit?.modifier;
  if (modifier === "sale" || extracted?.onSale === true) {
    moveExplicitToStale(memory, "badge");
    return;
  }
  if (modifier === "new" || modifier === "bestseller") {
    moveExplicitToStale(memory, "onSale");
  }
}

function pushFact(memory, key, value, source, turnIndex, confidence) {
  memory.facts.push({ key, value, source, turnIndex, confidence });
}

// Apply the intent resolver's `staleKeysToDrop` decision: each
// listed key is moved from explicit → stale so downstream consumers
// see the cleaned scope and the diagnostic log retains the
// invalidated value. Empty drop list is a no-op.
function applyStaleDrops(memory, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return;
  for (const k of keys) {
    if (memory.explicit[k] != null) {
      memory.stale[k] = memory.explicit[k];
      delete memory.explicit[k];
    }
  }
}

// Move every subject-bound key to stale. Used for the recipient-
// without-gender path ("for my partner"), which still implies a
// subject switch even though the recipient word doesn't disambiguate
// gender. Resolved separately from the linguistic intent path.
function staleAllSubjectBound(memory) {
  for (const k of SUBJECT_PIVOT_KEYS) {
    if (memory.explicit[k] != null) {
      memory.stale[k] = memory.explicit[k];
      delete memory.explicit[k];
    }
  }
}

function normalizeCategoryTerm(value) {
  return String(value || "").toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function clearAcceptedCategoryRejection(rejectedSet, category) {
  const cat = normalizeCategoryTerm(category);
  if (!cat) return;
  if (cat === "footwear" || cat === "shoes" || cat === "shoe") {
    // A broad accepted scope ("show me shoes") should not undo a
    // customer's specific rejection ("I don't like sandals"). Only
    // remove rejected broad nouns for footwear itself.
    for (const term of ["footwear", "shoes", "shoe"]) rejectedSet.delete(term);
    return;
  }
  rejectedSet.delete(cat);
  if (cat.endsWith("s")) rejectedSet.delete(cat.slice(0, -1));
  else rejectedSet.delete(`${cat}s`);
}

// Classify the bot's OWN outgoing clarifier into the slot it asks about.
// This inspects our own generated text (not customer intent), so chip +
// phrasing detection is appropriate. Order-independent and phrasing-tolerant
// so a clarifier is recognized however the LLM (or a gate) words it — that
// reliability is what lets the repeat-clarifier guard actually fire.
export function detectClarifyingQuestionType(text) {
  const value = String(text || "");
  if (!value.trim()) return null;
  const hasMenChip = /<<\s*(?:Men|Boys?)(?:'?s)?\s*>>/i.test(value);
  const hasWomenChip = /<<\s*(?:Women|Girls?)(?:'?s)?\s*>>/i.test(value);
  if (
    (hasMenChip && hasWomenChip) ||
    /\bmen'?s?\s+or\s+women'?s?\b/i.test(value) ||
    /\bwomen'?s?\s+or\s+men'?s?\b/i.test(value) ||
    /\bmen'?s?,?\s+women'?s?,?\s+or\s+kids'?/i.test(value) ||
    /\bwho\s+(?:are|is)\s+(?:these|this)\s+for\b/i.test(value) ||
    /\bwhich\s+styles?\s+would\s+you\s+like\s+to\s+browse\b/i.test(value) ||
    /\b(?:shopping|browsing|looking)\s+for\s+(?:men|women)/i.test(value)
  ) {
    return "gender";
  }
  if (/\bwhat'?s?\s+your\s+budget\b|\bhow\s+much\b[^?]{0,40}\b(?:spend|budget|looking\s+to\s+pay)\b|<<\s*Under\s+\$\d+/i.test(value)) {
    return "budget";
  }
  if (/\bwhat\s+(?:type|kind|style|category)\s+of\b|\bwhich\s+(?:type|kind|style|category)\b/i.test(value)) {
    return "category";
  }
  if (/\bwhat\s+size\b|\bwhich\s+size\b|\bwhat\s+width\b|\bwide\s+or\s+regular\b|\bwide\s+or\s+narrow\b/i.test(value)) {
    return "size_width";
  }
  return null;
}

export function buildSessionMemory({ messages, classifiedIntent, resolverState } = {}) {
  const memory = {
    explicit: { rejectedCategories: [] },
    inferred: {},
    stale: {},
    facts: [],
    lastClarifyingQuestion: null,
    // Set after the per-turn loop to the intent of the LAST user
    // turn. Downstream consumers (response-contract listing
    // template, suggestion validator, future logging) read this
    // instead of re-deriving intent from text. Shape:
    //   { label, confidence, reason, staleKeysToDrop,
    //     extractedThisTurn: { gender?, category?, color?, ... } }
    latestTurnIntent: null,
  };

  if (!Array.isArray(messages) || messages.length === 0) return memory;

  const rejectedSet = new Set();
  const choiceEventsByTurn = new Map();
  for (const event of extractChoiceEvents(messages, { limit: 10_000 })) {
    const list = choiceEventsByTurn.get(event.userTurnIndex) || [];
    list.push(event);
    choiceEventsByTurn.set(event.userTurnIndex, list);
  }
  // The intent + extracted constraints for the LAST user turn — we
  // capture them inside the loop and expose them as
  // `memory.latestTurnIntent` after the loop completes.
  let latestIntent = null;
  let latestExtracted = null;

  messages.forEach((msg, i) => {
    if (!msg) return;
    if (msg.role === "assistant" && typeof msg.content === "string") {
      const type = detectClarifyingQuestionType(msg.content);
      if (type) {
        memory.lastClarifyingQuestion = {
          type,
          turnIndex: i,
          text: msg.content.slice(0, 180),
        };
      }
      return;
    }
    if (msg.role !== "user" || typeof msg.content !== "string") return;
    const text = msg.content.trim();
    if (!text) return;

    // 1. Per-turn scalar extraction (lex-matched).
    const extracted = {
      ...extractUserConstraints(text),
      ...detectSizeWidth(text),
      ...detectMerchandisingScope(text),
    };

    if (extracted.category === "orthotics" && prefersFootwearBeforeOrthotics(text)) {
      extracted.category = "footwear";
    }

    // 2. Recipient → gender pivot. Recipient phrasing implies the
    //    shopping subject changed; override extracted gender.
    const recipient = detectRecipient(text);
    if (recipient.matched && recipient.gender) {
      extracted.gender = recipient.gender;
    }

    // 3. ONE authority for what this turn does to the prior scope.
    //    resolveTurnIntent classifies the turn (pivot_full /
    //    pivot_category / pivot_color / refine / continue / meta /
    //    ambiguous) and returns the keys that the customer just
    //    invalidated. Old per-trigger blocks (gender-only
    //    continuation, category pivot, broad reset, use-case
    //    conflict, pronoun back-reference) all live inside that
    //    function now. The session-memory loop just applies the
    //    decision.
    // Include INFERRED gender in previousScope so a resolver-inferred
    // gender (e.g. inferred=women from a "pink sandals" turn) still
    // triggers the gender-pivot rule when the next turn names a new
    // gender. Without this, prev.gender was null and rule 7 missed
    // pivots like "best dress shoes for men" carrying over sandals/
    // pink/bunions from the previous women-inferred turn. See live
    // failure 2026-06-02 17:53:49.
    const previousScope = { ...memory.explicit };
    delete previousScope.rejectedCategories;
    if (previousScope.gender == null && memory.inferred?.gender != null) {
      previousScope.gender = memory.inferred.gender;
    }
    const intent = resolveTurnIntent({
      latestUserText: text,
      previousScope,
      extractedUserConstraints: extracted,
      choiceEvents: choiceEventsByTurn.get(i) || [],
      turnIndex: i,
    });
    applyStaleDrops(memory, intent.staleKeysToDrop);
    // The intent from the LAST user turn becomes the published
    // signal. Each iteration overwrites — by definition only the
    // most recent user turn matters for downstream "what does the
    // customer want right now" decisions.
    latestIntent = intent;
    latestExtracted = extracted;

    // 3b. Recipient pivot without a derived gender ("for my
    //     partner"). This is a recipient-specific signal — the
    //     intent resolver can't see it from text alone, so it stays
    //     here as a separate step. Drops the entire subject-bound
    //     scope plus gender.
    if (recipient.matched && !recipient.gender && memory.explicit.gender) {
      staleAllSubjectBound(memory);
      memory.stale.gender = memory.explicit.gender;
      delete memory.explicit.gender;
    }

    // 4. Apply extracted scalars (latest wins).
    for (const k of SCALAR_KEYS) {
      if (extracted[k] != null) {
        memory.explicit[k] = extracted[k];
        pushFact(memory, k, extracted[k], "user_text", i, 0.9);
      }
    }

    // 5. Structured choice events: user's reply matched a prior chip
    //    or short yes/no question. Layered AFTER extraction so clicks
    //    override loose lex matches.
    for (const event of choiceEventsByTurn.get(i) || []) {
      if (event.fact) {
        memory.explicit[event.fact.key] = event.fact.value;
        pushFact(
          memory,
          event.fact.key,
          event.fact.value,
          event.type === "chip_answer" ? "chip_click" : "choice_answer",
          i,
          event.type === "chip_answer" ? 1.0 : 0.8,
        );
      }
    }

    normalizeMerchandisingScope(memory, extracted);

    // 6. Rejections. They persist across turns, but an explicit later
    // category request overrides the earlier rejection for that exact
    // category ("no sandals" → "actually sandals are fine").
    const latestRejections = detectRejectedCategories(text);
    for (const r of latestRejections) {
      rejectedSet.add(String(r).toLowerCase());
    }
    if (extracted.category && latestRejections.size === 0) {
      clearAcceptedCategoryRejection(rejectedSet, extracted.category);
    }
  });

  memory.explicit.rejectedCategories = Array.from(rejectedSet);

  // Publish the LAST user turn's intent + extracted constraints.
  // Single shared signal — response-contract / suggestion-validator
  // read this instead of re-deriving intent from text.
  if (latestIntent) {
    memory.latestTurnIntent = {
      label: latestIntent.label,
      confidence: latestIntent.confidence,
      reason: latestIntent.reason,
      staleKeysToDrop: latestIntent.staleKeysToDrop,
      extractedThisTurn: latestExtracted || {},
    };
  }

  // 7. Layer classifier attrs as INFERRED, not explicit. The classifier
  //    is a Haiku that READS conversation context; its output is a guess
  //    about what the customer probably means, not what they literally
  //    said. Filing it as `memory.explicit` lets a hallucination
  //    ("in white" → useCase=athletic_training_sports) become a hard
  //    catalog constraint the resolver then enforces — that's wrong.
  //    Resolver and downstream consumers can read `memory.inferred` to
  //    break ties, but never treat it as a customer-stated fact.
  if (classifiedIntent?.attributes) {
    const a = classifiedIntent.attributes;
    const lastTurnIndex = messages.length - 1;
    // The classifier's `useCase` enums are orthotic-specific
    // (dress_no_removable, comfort_bundle, athletic_running). They are
    // valid memory only on actual orthotic turns; on regular footwear
    // turns they're wrong terminology and break the catalog resolver.
    const isOrthoticTurn = classifiedIntent.isOrthoticRequest === true;
    const keys = isOrthoticTurn ? ["gender", "condition", "useCase"] : ["gender", "condition"];
    for (const k of keys) {
      if (a[k] != null && memory.explicit[k] == null && memory.inferred[k] == null) {
        // Normalize classifier capitalization (e.g. "Women" → "women")
        const v = typeof a[k] === "string" ? a[k].toLowerCase() : a[k];
        memory.inferred[k] = v;
        pushFact(memory, k, v, "classifier", lastTurnIndex, 0.7);
      }
    }
  }

  // 8. Layer resolver inferred constraints (per turn).
  if (resolverState && resolverState.type === "resolver_state") {
    const inf = resolverState.inferred_constraints || {};
    for (const [k, v] of Object.entries(inf)) {
      if (v?.value != null && memory.inferred[k] == null) {
        memory.inferred[k] = v.value;
        pushFact(memory, k, v.value, "resolver_inferred", messages.length - 1, 0.9);
      }
    }
    // Resolver-matched specificProduct flows in as explicit (handle
    // detection is conservative — only ever fires on a strong match).
    const matched = resolverState.matched_constraints || {};
    if (matched.specificProduct != null && memory.explicit.specificProduct == null) {
      memory.explicit.specificProduct = matched.specificProduct;
      pushFact(memory, "specificProduct", matched.specificProduct, "resolver_matched", messages.length - 1, 0.95);
    }

    // 9. Catalog-contradiction resolution. When resolver inferred a
    //    gender that contradicts a stale explicit memory.gender (i.e.
    //    the user pivoted to a category that doesn't exist for the
    //    explicit gender), trust the catalog inference and move the
    //    old explicit to stale. Example: customer was browsing men's
    //    items, then asks "navy heels" — heels are women's-only in
    //    the catalog → resolver infers gender=women → here we promote
    //    that inference so the LLM doesn't say "we don't carry men's
    //    heels" when the customer never asked about men's heels.
    if (
      memory.inferred.gender &&
      memory.explicit.gender &&
      memory.inferred.gender !== memory.explicit.gender
    ) {
      memory.stale.gender = memory.explicit.gender;
      memory.explicit.gender = memory.inferred.gender;
      pushFact(memory, "gender", memory.inferred.gender, "catalog_contradiction_resolution", messages.length - 1, 0.95);
    }
  }

  return memory;
}

// Compact one-line summary for the per-turn [memory] log.
export function memorySummary(memory) {
  if (!memory) return "explicit={} stale={} facts=0";
  const formatScope = (obj) => {
    const parts = [];
    for (const [k, v] of Object.entries(obj || {})) {
      if (Array.isArray(v)) {
        if (v.length > 0) parts.push(`${k}=[${v.join(",")}]`);
      } else if (v != null && v !== "") {
        parts.push(`${k}=${v}`);
      }
    }
    return parts.join(" ");
  };
  const explicit = formatScope(memory.explicit) || "-";
  const inferred = formatScope(memory.inferred) || "-";
  const stale = formatScope(memory.stale) || "-";
  const sources = Array.from(new Set((memory.facts || []).map((f) => f.source))).join(",") || "-";
  return `explicit={ ${explicit} } inferred={ ${inferred} } stale={ ${stale} } source=${sources} facts=${memory.facts.length}`;
}

// Build a compact, customer-safe prompt block exposing the keyed
// memory to the LLM. Internal-language-leak strip in
// chat-postprocessing will catch any accidental verbatim emission.
export function buildSessionMemoryPromptBlock(memory) {
  if (!memory) return "";
  const explicit = memory.explicit || {};
  const lines = [];
  // Filter to non-empty values; rejectedCategories only when non-empty.
  for (const k of SCALAR_KEYS) {
    if (explicit[k] != null && explicit[k] !== "") {
      lines.push(`- ${k}: ${explicit[k]}`);
    }
  }
  if (Array.isArray(explicit.rejectedCategories) && explicit.rejectedCategories.length > 0) {
    lines.push(`- rejected_categories: ${explicit.rejectedCategories.join(", ")}`);
  }
  if (lines.length === 0) return "";
  return [
    "",
    "=== Customer scope so far (session memory) ===",
    "These are facts the customer has established this session. Use them in tool calls and replies; do not re-ask any of them.",
    ...lines,
    "",
  ].join("\n");
}
