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

const SCALAR_KEYS = [
  "gender", "category", "color", "size", "width",
  "condition", "useCase", "arch", "overpronation",
  "specificProduct",
];

// Scope that is owned by a specific gender. When the gender pivots,
// these get moved to `stale`.
const SUBJECT_PIVOT_KEYS = [
  "category", "color", "size", "width",
  "condition", "useCase", "arch", "overpronation",
  "specificProduct",
];

// Recipient → gender heuristic. The mapping is deliberately
// conservative — "partner", "friend", "coworker", "spouse" don't
// imply a gender, so they reset scope without setting one.
const RECIPIENT_RE =
  /\b(?:for|gift\s+for|shopping\s+for|to\s+buy\s+for|my)\s+(wife|husband|partner|girlfriend|boyfriend|spouse|mom|mother|dad|father|son|daughter|child|kid|kids|grandma|grandpa|grandmother|grandfather|grandson|granddaughter|nephew|niece|sister|brother|aunt|uncle|friend|coworker)\b/i;

const RECIPIENT_TO_GENDER = {
  wife: "women", girlfriend: "women", mom: "women", mother: "women",
  daughter: "women", grandma: "women", grandmother: "women",
  granddaughter: "women", sister: "women", aunt: "women", niece: "women",
  husband: "men", boyfriend: "men", dad: "men", father: "men", son: "men",
  grandpa: "men", grandfather: "men", grandson: "men", brother: "men",
  uncle: "men", nephew: "men",
  child: "kids", kid: "kids", kids: "kids",
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

// Detect chip markup in an assistant message and return [{label, value}].
const CHIP_RE = /<<\s*([^<>]+?)\s*>>/g;
function parseAssistantChips(content) {
  if (typeof content !== "string") return [];
  const out = [];
  CHIP_RE.lastIndex = 0;
  let m;
  while ((m = CHIP_RE.exec(content)) !== null) {
    const label = m[1].trim();
    if (label) out.push({ label, value: label });
  }
  return out;
}

// Map a chip label to its keyed-memory fact. Used when the user's
// reply EXACTLY matches one of the prior assistant's chip labels.
// Returns null when the chip doesn't map to a known scalar.
function mapChipToKey(label) {
  const lc = String(label).toLowerCase().trim();
  if (/^men'?s?$/.test(lc) || lc === "male") return { key: "gender", value: "men" };
  if (/^women'?s?$/.test(lc) || lc === "female") return { key: "gender", value: "women" };
  if (lc === "kids" || lc === "kid") return { key: "gender", value: "kids" };
  if (/^(?:low|medium|high)(?:\s+arch)?$/.test(lc)) return { key: "arch", value: lc.replace(/\s+arch$/, "") };
  if (lc === "yes" || lc === "no") return null; // ambiguous without context
  if (/plantar/i.test(lc)) return { key: "condition", value: "plantar_fasciitis" };
  if (/ball[- ]?of[- ]?foot|metatarsalgia/i.test(lc)) return { key: "condition", value: "metatarsalgia" };
  if (/bunion/i.test(lc)) return { key: "condition", value: "bunions" };
  if (/flat\s*feet|low\s*arch/i.test(lc)) return { key: "condition", value: "flat_feet" };
  if (/high\s*arch/i.test(lc)) return { key: "condition", value: "high_arch" };
  // Path-ambig / domain chips — surface as a category cue
  if (lc === "the shoes themselves" || lc === "footwear with arch support") {
    return { key: "category", value: "footwear" };
  }
  if (lc === "orthotic insole for these" || lc === "orthotic insole") {
    return { key: "category", value: "orthotics" };
  }
  return null;
}

function pushFact(memory, key, value, source, turnIndex, confidence) {
  memory.facts.push({ key, value, source, turnIndex, confidence });
}

function moveScopeToStale(memory) {
  for (const k of SUBJECT_PIVOT_KEYS) {
    if (memory.explicit[k] != null) {
      memory.stale[k] = memory.explicit[k];
      delete memory.explicit[k];
    }
  }
}

export function buildSessionMemory({ messages, classifiedIntent, resolverState } = {}) {
  const memory = {
    explicit: { rejectedCategories: [] },
    inferred: {},
    stale: {},
    facts: [],
  };

  if (!Array.isArray(messages) || messages.length === 0) return memory;

  const rejectedSet = new Set();
  let priorAssistant = null;

  messages.forEach((msg, i) => {
    if (!msg) return;
    if (msg.role === "assistant" && typeof msg.content === "string") {
      priorAssistant = msg;
      return;
    }
    if (msg.role !== "user" || typeof msg.content !== "string") return;
    const text = msg.content.trim();
    if (!text) return;

    // 1. Per-turn scalar extraction (lex-matched).
    const extracted = { ...extractUserConstraints(text), ...detectSizeWidth(text) };

    // 2. Recipient → gender pivot. Recipient phrasing implies the
    //    shopping subject changed; override extracted gender.
    const recipient = detectRecipient(text);
    if (recipient.matched && recipient.gender) {
      extracted.gender = recipient.gender;
    }

    // 3. Subject pivot: gender change clears subject-owned scope.
    if (
      memory.explicit.gender &&
      extracted.gender &&
      extracted.gender !== memory.explicit.gender
    ) {
      moveScopeToStale(memory);
    }
    // Recipient pivot without a derived gender (e.g. "for my partner")
    // still resets the gender-owned scope so we don't carry the prior
    // subject's category/size forward.
    if (recipient.matched && !recipient.gender && memory.explicit.gender) {
      moveScopeToStale(memory);
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

    // 5. Chip-answer detection: user's reply EXACTLY matches one of
    //    the prior assistant's chip labels → mapped chip key. Layered
    //    AFTER extraction so chip clicks override loose lex matches.
    if (priorAssistant) {
      const chips = parseAssistantChips(priorAssistant.content);
      const normUser = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
      for (const chip of chips) {
        const normChip = chip.label.toLowerCase().replace(/[^a-z0-9]+/g, "");
        if (normChip && normChip === normUser) {
          const mapped = mapChipToKey(chip.label);
          if (mapped) {
            memory.explicit[mapped.key] = mapped.value;
            pushFact(memory, mapped.key, mapped.value, "chip_click", i, 1.0);
          }
          break;
        }
      }
    }

    // 6. Rejections (additive across all turns).
    for (const r of detectRejectedCategories(text)) {
      rejectedSet.add(String(r).toLowerCase());
    }

    priorAssistant = null;
  });

  memory.explicit.rejectedCategories = Array.from(rejectedSet);

  // 7. Layer classifier attrs — they only describe the LATEST turn.
  //    Only fill gaps; don't overwrite an explicit user statement.
  if (classifiedIntent?.attributes) {
    const a = classifiedIntent.attributes;
    const lastTurnIndex = messages.length - 1;
    for (const k of ["gender", "condition", "useCase"]) {
      if (a[k] != null && memory.explicit[k] == null) {
        // Normalize classifier capitalization (e.g. "Women" → "women")
        const v = typeof a[k] === "string" ? a[k].toLowerCase() : a[k];
        memory.explicit[k] = v;
        pushFact(memory, k, v, "classifier", lastTurnIndex, 0.85);
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
