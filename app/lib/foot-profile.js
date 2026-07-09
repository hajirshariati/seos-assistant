// ── Session foot profile (lightweight, conversation-derived) ──────────────────
//
// Cross-turn continuity signals a good associate remembers: which conditions
// the customer has mentioned, their width/size preferences, and which product
// families they were already shown. Derived purely from the conversation's
// USER messages + prior shown cards — no DB, no new persistence, no PII beyond
// what the customer already typed. Surfaced to the model as a SHORT prompt
// block only on workflows where it changes the answer (advisory / availability
// / sizing). Pure + testable.

const PROFILE_CONDITION_RE = new RegExp(
  "\\b(plantar\\s+fasciitis|fasciitis|bunions?|neuroma|metatarsalgia|overpronation|supination|" +
  "flat\\s+feet|fallen\\s+arches|high\\s+arches|heel\\s+pain|heel\\s+spurs?|arch\\s+pain|foot\\s+pain|" +
  "diabet(?:es|ic)|arthritis|swollen\\s+feet)\\b",
  "gi",
);
const WIDTH_RE = /\b(wide|extra[-\s]?wide|narrow)\b(?:\s+(?:width|fit|feet|foot|sizes?))?/i;
const SIZE_RE = /\bsize\s+(\d{1,2}(?:\.5)?)\b/gi;

// Which workflows benefit from the profile (advisory / availability / sizing —
// never policy/support, where past conditions are irrelevant and distracting).
const PROFILE_RELEVANT_WORKFLOWS = new Set([
  "condition_recommendation",
  "multi_recommendation",
  "named_product_advisory",
  "comparison",
  "availability",
  "prior_evidence_availability",
  "compatibility",
  "sizing_help",
  "product_focus",
]);

// Build the profile from the conversation. `messages` = the request's message
// history ({role, content}); `priorShownTitles` = titles of cards shown in
// earlier turns (family continuity).
export function buildFootProfile({ messages = [], priorShownTitles = [] } = {}) {
  const userText = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === "user" && typeof m.content === "string")
    .map((m) => m.content)
    .join("\n");
  const conditions = [...new Set(
    (userText.match(PROFILE_CONDITION_RE) || []).map((c) => c.toLowerCase().replace(/\s+/g, " ").trim()),
  )].slice(0, 4);
  const widthMatch = userText.match(WIDTH_RE);
  const width = widthMatch ? widthMatch[1].toLowerCase().replace(/\s+/g, "-") : null;
  const sizes = [...new Set([...userText.matchAll(SIZE_RE)].map((m) => m[1]))].slice(0, 2);
  const families = [...new Set(
    (Array.isArray(priorShownTitles) ? priorShownTitles : [])
      .map((t) => String(t || "").trim().split(/\s+/)[0])
      .filter((w) => w && /^[A-Z]/.test(w) && !/^(Men|Women|Kids|The|Aetrex)/i.test(w)),
  )].slice(0, 4);
  const empty = conditions.length === 0 && !width && sizes.length === 0 && families.length === 0;
  return { conditions, width, sizes, families, empty };
}

// Short prompt block — one line per known signal, nothing invented. Empty
// string when the profile has nothing or the workflow doesn't need it.
export function buildFootProfilePromptBlock(profile, workflow = "") {
  if (!profile || profile.empty) return "";
  if (!PROFILE_RELEVANT_WORKFLOWS.has(String(workflow || ""))) return "";
  const lines = ["=== CUSTOMER PROFILE (from THIS conversation — use it, don't re-ask) ==="];
  if (profile.conditions.length) lines.push(`Mentioned conditions: ${profile.conditions.join(", ")}. Factor these into support/comfort framing (never promise treatment).`);
  if (profile.width) lines.push(`Width preference: ${profile.width}. Prefer ${profile.width}-friendly options and say so.`);
  if (profile.sizes.length) lines.push(`Stated size: ${profile.sizes.join(", ")}.`);
  if (profile.families.length) lines.push(`Previously shown: ${profile.families.join(", ")}. Build on these — reference or contrast rather than restarting.`);
  return lines.join("\n");
}
