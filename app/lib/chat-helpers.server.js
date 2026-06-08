// Pure helpers extracted from app/routes/chat.jsx so they can be
// exercised in evals without booting the route handler.
//
// Keep these dependency-free (no Prisma, no Anthropic, no env access).
// The route imports the same functions.

const MALE_PATTERN = /\b(men['‘’]?s|mens|men|male|males|guy|guys|dude|dudes|dad|father|husband|boyfriend|brother|son|grandpa|grandfather|uncle|nephew|man|boy|boys)\b/i;
const FEMALE_PATTERN = /\b(women['‘’]?s|womens|women|female|females|lady|ladies|mom|mother|wife|girlfriend|sister|daughter|grandma|grandmother|aunt|niece|woman|girl|girls)\b/i;

// Kids-context phrases that must be neutralized BEFORE the MALE/FEMALE
// scan. Bare \bson\b lives in MALE_PATTERN (real adults: "for my son who
// is in the army") and \bdaughter\b is in FEMALE_PATTERN — but in kids
// contexts they're false positives that would latch sessionGender to
// men's/women's footwear and exclude the actual product the kid needs.
//
// Mirrors the Kids-first patterns in orthotic-flow.server.js
// KEYWORD_PATTERNS.gender (b543bd0). Without this mirror, the gate
// classified "my son" as Kids while detectGenderFromHistory classified
// it as Men — sessionGender locked to men's, and the gate's correct
// Kids state was overridden by the search-time gender filter.
//
// Production trace 2026-05-10: "i want pink sandals with arch support
// and i have bunions" hit gender-lock = Men (from earlier "my son"
// turn) even though no male signal was anywhere in the latest turn.
const KIDS_CONTEXT_PATTERN = /\b(?:my\s+(?:son|daughter)|\d+[\s-]*(?:year|yr)s?[\s-]*old\s+(?:son|daughter)|(?:young|little|toddler|teen|teenage|baby|infant)\s+(?:son|daughter)|(?:boys|girls|boy['‘’]?s|girl['‘’]?s))\b/gi;

// ── Negation context detection (shared) ───────────────────────────────
// Used by gender detection AND color injection. Decides whether a term
// matched at position `matchIndex` in `text` is preceded by a negation
// that semantically excludes it.
//
// Why this is harder than "regex for 'no' before the term":
//   - Long-form negation: "I do not want anything black" — 3 words sit
//     between 'not' and 'black'. A tight regex misses it.
//   - Reaffirmation: "not red but green" — 'but' cancels the 'not' for
//     'green'. A simple distance check would mistakenly flag 'green' as
//     negated.
//   - Distance: "not for hiking, in red please" — 'red' is far past the
//     'not'; the negation referred to "hiking", not the color. We cap
//     the distance at 4 tokens.
//
// The window is fixed at 50 chars before the term. We scan all negation
// words in the window, take the LAST one (closest to the term), then:
//   - If the gap contains "but" or "except" → reaffirmation, NOT negated.
//   - If the gap exceeds 4 tokens → too far away, NOT negated.
//   - Otherwise → negated.
//
// Vocabulary is generic English — no merchant-specific terms. Works
// identically for any vertical (footwear, apparel, electronics, etc.).
const NEGATION_WORDS_RE = /\b(?:no|not|without|except|skip|forget|anything\s+but|don'?t\s+want|do\s+not\s+want|other\s+than|never|absolutely\s+no)\b/gi;
// Reaffirmation cancels the negation for the term being checked.
//   - Explicit conjunctions: "but", "except", "instead", "rather"
//   - Clause boundary (comma or semicolon) followed by a positive lead
//     word: "for", "in", "with", "i (want|need|prefer|like)", "show",
//     "give", etc. Catches "not for men, for women" and "I don't want
//     red, show me blue".
const REAFFIRMATION_RE = /\b(?:but|except|other\s+than|instead|rather)\b|[,;]\s+(?:for|in|with|i'?d|i\s+(?:want|need|prefer|like)|just|maybe|please|show|give|let|find|the|want|need|prefer|like|got|how\s+about|what\s+about)\b/i;
const NEGATION_WINDOW_CHARS = 50;
const MAX_NEGATION_DISTANCE_TOKENS = 4;

export function isPrecededByNegation(text, matchIndex) {
  const window = String(text || "").slice(
    Math.max(0, Number(matchIndex) - NEGATION_WINDOW_CHARS),
    Number(matchIndex),
  );
  // Find the LAST (closest-to-term) negation word in the window.
  let lastNeg = null;
  let m;
  NEGATION_WORDS_RE.lastIndex = 0;
  while ((m = NEGATION_WORDS_RE.exec(window)) !== null) {
    lastNeg = m;
    if (NEGATION_WORDS_RE.lastIndex === m.index) NEGATION_WORDS_RE.lastIndex += 1;
  }
  if (!lastNeg) return false;

  // Text between the negation word and the matched term.
  const afterNeg = window.slice(lastNeg.index + lastNeg[0].length);

  // Reaffirmation: "not red but green" — for 'green', the 'but' cancels
  // the 'not'. Skip the term-is-negated verdict.
  if (REAFFIRMATION_RE.test(afterNeg)) return false;

  // Distance check: too many tokens between negation and term means the
  // negation referred to something else.
  const tokens = afterNeg.trim().split(/\s+/).filter(Boolean);
  return tokens.length <= MAX_NEGATION_DISTANCE_TOKENS;
}

// Negation-aware match-finder. Tests whether `text` contains a match
// of `pattern` that is NOT preceded by a negation word. Returns the
// index of the first affirmed match, or -1.
//
// Rationale: the customer can say "not for men, for women" — naive
// MALE_PATTERN.test("not for men, for women") returns true and would
// pin gender=men. A regex match in negation context should NOT count.
function findAffirmedMatch(text, pattern) {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!isPrecededByNegation(text, m.index)) return m.index;
    // Move past this match to avoid infinite loop on zero-width.
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  return -1;
}

// Latest USER gender wins. We only ever read user messages — never
// assistant text. The assistant echoes whatever it last said, so an
// assistant fallback always biases toward the AI's previous turn
// instead of toward the customer's actual current intent. If the
// customer pivots ("actually this is for me — I'm a woman"), the
// nearest user turn carrying a gender token wins, and pre-pivot
// assistant mentions of the prior gender don't get a vote.
//
// Negation-aware: "not for men, for women" returns "women" (the
// affirmed term wins, not the negated one). "I don't want men's"
// + later turn says "for my wife" → wife wins, men's was negated
// AND superseded.
//
// Chip-driven answers (where the user clicks "Women's" but their
// next free-text message has no gender word) are covered by the
// synthetic-choice injection in chat.jsx, which seeds answeredChoices
// from the chip click — so we don't need the assistant fallback to
// recover those cases.
export function detectGenderFromHistory(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue;
    const rawText = typeof messages[i].content === "string" ? messages[i].content : "";
    // Mask kid-context phrases first so "my son" / "9yr old daughter"
    // don't trip MALE_PATTERN/FEMALE_PATTERN. Replace with spaces so
    // index positions don't shift catastrophically (negation window
    // distance is tolerant of extra whitespace).
    const text = rawText.replace(KIDS_CONTEXT_PATTERN, (m) => " ".repeat(m.length));
    const maleIdx = findAffirmedMatch(text, MALE_PATTERN);
    const femaleIdx = findAffirmedMatch(text, FEMALE_PATTERN);
    // Both affirmed in the same message: the LATER (rightmost) one
    // wins, since "men's, actually women's" or "for him — wait,
    // her" represents a within-message correction.
    if (maleIdx >= 0 && femaleIdx >= 0) {
      return maleIdx > femaleIdx ? "men" : "women";
    }
    if (maleIdx >= 0) return "men";
    if (femaleIdx >= 0) return "women";
  }
  return null;
}

// ── reconcileSessionGender ──────────────────────────────────────────
// Single source of truth for adult gender. The bot derives a session
// gender three ways (positional regex over history, recipient pivot,
// and the LLM classifier); they can disagree. The classifier extracts
// gender ONLY when the customer explicitly stated it (this or a recent
// turn), so a confident Men/Women from it is higher-precision than the
// positional regex scan — which can re-land on a stale earlier mention
// after a recipient pivot ("a gift for my mom" following an earlier
// "men's"), producing the "we don't have men's" dead-end.
//
// Rule: the classifier wins for adult genders when it is confident;
// otherwise keep the regex value. Deliberately scoped to men/women —
// "Kids" keeps the regex value because kids uses lowercase tokens
// (kid/boy/girl) and a separate scoping path we don't want to disturb
// from here. Inputs: regexGender ("men"|"women"|"kid"|"boy"|"girl"|
// null), classifierGender ("Men"|"Women"|"Kids"|null), confidence
// ("low"|"medium"|"high"|undefined). Returns the authoritative gender
// (lowercase) or null.
export function reconcileSessionGender(regexGender, classifierGender, classifierConfidence) {
  const cg = String(classifierGender || "").toLowerCase().trim();
  const conf = String(classifierConfidence || "medium").toLowerCase().trim();
  if ((cg === "men" || cg === "women") && conf !== "low") return cg;
  return regexGender || null;
}

// Strip "let me look that up", "i'll find", "one moment" etc. from the
// AI's response. Compliance backstop for the BANNED NARRATION prompt
// rule the model intermittently violates. Returns the cleaned string;
// when nothing matched, returns input.
// Lookbehind so back-to-back phrases ("Hold on. Let me search.") both
// match — `(?<=^|\s)` would consume the boundary and miss the second.
// Covers:
//   "let me X" / "i'll X" with a wide verb list (look, find, search,
//     check, see, pull up, grab, get, look up, look at)
//   "i need to X" / "let me get the details" — softer but still
//     narrative announcements the AI ships before tool calls
//   "one moment" / "hold on" / "right away" / "give me a second"
// Note: "here's what I found/got" is INTENTIONALLY not in this list.
// It's a normal plural-intro presentation phrase, and stripping it
// (with the trailing [^.!?]* sentence-eater) deletes the entire
// product-presentation sentence — which then makes hasPluralIntroFraming
// fail and cascades into cards getting suppressed. Leave it alone.
const BANNED_NARRATION = /(?<=^|\s)(?:let me (?:look (?:that |it )?up|find|search|check|see|pull (?:up|that up|that)|grab|get|look at|get the details|broaden|widen|expand|try (?:a |again|another)|narrow|refine|search again|do (?:a|another) search)(?:[^.!?\n]*)?[.!?]?|i['‘’]?ll (?:look|find|search|check|see|pull|grab|get|need to|try|broaden|widen)(?:[^.!?\n]*)?[.!?]?|i need to (?:pull up|look up|look at|find|search|check|see|grab|get|broaden|widen|try)(?:[^.!?\n]*)?[.!?]?|one moment[!.]?|hold on[!.]?|right away[!.]?|give me a (?:second|sec|moment)[!.]?|that (?:result|search|one) (?:is|was|isn['‘’]?t|doesn['‘’]?t)(?:[^.!?\n]*)?[.!?]?|the (?:search (?:above|results?)|results? (?:above|so far|i found)|previous (?:result|search))(?:[^.!?\n]*)?[.!?]?|searching (?:for|the catalog|now)(?:[^.!?\n]*)?[.!?]?)/gi;

// Tool-use / process narration. The AI sometimes explains to the
// customer how it ran its tools — "The search returned X rather
// than Y", "I searched for shoes and got insoles", "My search
// turned up...", "Looking at the results...". Customers don't care
// about the AI's process; they care about the answer. These leak
// the robot underneath. Strip the entire offending sentence.
//
// Patterns:
//   "the search/my search/that search (returned|found|yielded|came back with|surfaced|gave me|brought back|pulled up|showed) X (rather than|but|however) Y."
//   "I (searched|looked) (for|up|at) X (and|but) Y."
//   "the results (came back|returned|show|showed|include|are) X (rather than|but) Y."
//   "looking at (the|my) (results|search|catalog), X."
//   "after searching/checking/looking, X."
// Two flavors:
//   FULL — sentence-shaped narration that's ALL process: strip the
//   whole sentence ("The search returned X. ...", "I searched for X").
//   PREFIX — clause-shaped narration that prefixes a real answer:
//   strip only up to the comma so the actual answer survives
//   ("Looking at the catalog, here are some sandals" → "here are
//   some sandals").
const TOOL_NARRATION_RE = new RegExp(
  [
    // FULL strips (consume to sentence end)
    String.raw`\b(?:the\s+search|my\s+search|that\s+search|the\s+results|search\s+results|my\s+results)\s+(?:returned|found|yielded|came\s+back\s+with|came\s+back|surfaced|gave\s+me|brought\s+back|pulled\s+up|showed|show|include|are)\b[^.!?\n]*[.!?]?\s*`,
    String.raw`\bi\s+(?:searched|looked|checked|pulled\s+up|ran\s+a\s+search)\s+(?:for|up|at|through|over)\b[^.!?\n]*[.!?]?\s*`,
    // PREFIX strips (consume only to comma — leave the actual answer)
    String.raw`\b(?:looking\s+at|after\s+(?:searching|checking|looking))\s+(?:the|my|our)?\s*(?:results|search|catalog|inventory)\b[^,\n]*,\s*`,
    String.raw`\b(?:from|based\s+on)\s+(?:the|my)\s+(?:search|search\s+results|results)\b[^,\n]*,\s*`,
  ].join("|"),
  "gi",
);

// Self-correction strip. The model sometimes streams a follow-up
// question, then realizes mid-stream that the customer already
// answered it: "Do you have arch pain? Wait — you already told me:
// arch pain." Both halves are dead weight to the customer.
//
// The leading `(?:[^.!?\n]*\?\s+)?` optionally consumes the preceding
// question sentence so we don't leave a stale question behind. The
// strip only fires when the self-correction phrase is present, so we
// never accidentally eat a real question.
//
// Triggers: wait / actually / oh / sorry / hmm / nevermind / hold on
// followed by EITHER:
//   (a) "you (already|just) told|said|mentioned|noted me/us…", OR
//   (b) the AI confessing its own mistake: "let me correct that",
//       "let me re(do|word|phrase|state) that", "I should rephrase",
//       "I (made|noticed) (a mistake|an error)", "scratch that",
//       "ignore that", "I meant…", "actually, …" mid-message.
// Both halves are visible noise — the customer just wants the
// answer, not an apology and a do-over written out loud.
const SELF_CORRECTION_RE = /(?:[^.!?\n]*\?\s+)?\b(?:wait|actually|oh|sorry|hmm|never\s*mind|nevermind|hold\s+on|scratch\s+that|ignore\s+that)[\s,—–-]+(?:you\s+(?:already\s+|just\s+)?(?:told|said|mentioned|noted)\s+(?:me|us)?\b[^.!?\n]*[.!?]?\s*|let\s+me\s+(?:correct|rephrase|reword|restate|redo|fix|revise)\s+(?:that|this|myself)\b[^.!?\n]*[.!?]?\s*|i\s+(?:should|need\s+to|meant\s+to)\s+(?:rephrase|reword|correct|clarify|restate)\b[^.!?\n]*[.!?]?\s*|i\s+(?:made|noticed)\s+(?:a\s+mistake|an\s+error)\b[^.!?\n]*[.!?]?\s*|i\s+meant\b[^.!?\n]*[.!?]?\s*)/gi;

// Reasoning-leak strip — AI sometimes narrates its internal decision
// process to the customer ("Based on the merchant's flow, I need to
// identify discomfort and gender before searching", "Following the
// rules, I should ask…", "Per the guide…", "X is already
// established"). Direct-address rule forbids this but the model
// intermittently leaks. Strip the offending sentence; the next
// sentence (usually the actual question to the customer) survives.
//
// Patterns covered:
//   - "based on / according to / per / following / given (the
//     merchant's flow|guide|rules|knowledge|sequence|context|
//     prompt|system|instructions|guidelines)..."
//   - "i need to / i still need to / i have to / i must / before i
//     can (identify|determine|establish|figure out|find out|
//     check|verify|confirm|know|search)..."
//   - "(the |your )(pain|gender|category|shoe type|product type|
//     activity|condition|use case|line|...) is (already )?
//     (established|set|locked|known|determined|confirmed|identified|
//     covered)..."
//   - "(per|in line with|consistent with) (the )?(merchant|store|
//     guide|flow|rules|guidelines|instructions)..."
const REASONING_LEAK_RE = new RegExp(
  [
    // "based on / according to / per / following / given the X"
    String.raw`\b(?:based on|according to|per|following|given|in line with|consistent with)\s+(?:the\s+|my\s+|our\s+|this\s+|your\s+)?(?:merchant['‘’]?s?|store['‘’]?s?|seller['‘’]?s?|knowledge|guide(?:lines?)?|rules?|flow|sequence|prompt|system|context|instructions?|decision\s+(?:tree|process)|process)\b[^.!?\n]*[.!?]?\s*`,
    // "i (still |also )?need to / have to / must / will need to / should X" + reasoning verb + "before|first|then"
    String.raw`\bi\s+(?:still\s+|also\s+|just\s+)?(?:need\s+to|have\s+to|must|should|will\s+need\s+to)\s+(?:identify|determine|establish|figure\s+out|find\s+out|verify|confirm)\b[^.!?\n]*[.!?]?\s*`,
    // "before i (can )?recommend|suggest|search|show|help"
    String.raw`\bbefore\s+i\s+(?:can\s+)?(?:recommend|suggest|search|show|help|narrow|pick|choose)\b[^.!?\n]*[.!?]?\s*`,
    // "the X is (already)? (established|set|known|locked|determined|confirmed|identified|covered)"
    String.raw`\b(?:the|your)\s+(?:pain|gender|category|shoe(?:\s+type)?|product(?:\s+type)?|activity|condition|use\s*case|line|brand|fit|style|topic|context|scope)\s+(?:is|are)\s+(?:already\s+|now\s+)?(?:established|set|locked|known|determined|confirmed|identified|covered|in\s+place)\b[^.!?\n]*[.!?]?\s*`,
    // "i (notice|see|notice that) X (wasn't|isn't|hasn't been) established/asked/answered/clarified"
    // — AI calling out its own workflow gap to the customer.
    String.raw`\bi\s+(?:notice|see|noticed|realize|realized|notice\s+that|see\s+that)\b[^.!?\n]*?\b(?:wasn['‘’]?t|isn['‘’]?t|hasn['‘’]?t\s+been|isn['‘’]?t\s+yet|wasn['‘’]?t\s+yet)\s+(?:established|set|asked|answered|clarified|determined|confirmed|specified|provided|mentioned)\b[^.!?\n]*[.!?]?\s*`,
  ].join("|"),
  "gi",
);

// Brand/info question detector. When the customer asks "tell me more
// about <brand>" / "what is <X>" / "who is <X>" / "where is <X>",
// the answer is a text-only explanation — NOT a product pitch.
// Without this guard, the empty-pool repair fires on phrases like
// "Aetrex is a premium brand — here are the highlights:" (the
// "here are" matches the product-pitch regex) and wipes the answer.
// Merchant trace 2026-05-13 12:26:23.
const BRAND_INFO_QUESTION_RE =
  /\b(?:tell\s+me\s+(?:more\s+)?about|what(?:'s| is)\s+(?:the\s+)?(?:brand|company|store)|who\s+(?:is|are)\s+(?:you|your\s+(?:company|brand|store)|aetrex|the\s+(?:brand|company))|where\s+(?:is|are)\s+(?:you|your\s+(?:company|brand|store|headquarters|hq))|about\s+(?:the\s+)?(?:brand|company|store|aetrex)|company\s+(?:info|history|background)|brand\s+(?:info|history|story|background))\b/i;

export function isBrandOrInfoQuestion(text) {
  if (!text || typeof text !== "string") return false;
  return BRAND_INFO_QUESTION_RE.test(text);
}

// Filler intensifier strip. The LLM sometimes drops mid-sentence
// hedges like "Honestly," / "Frankly," / "Truthfully," that read as
// awkward asides in a customer-facing reply ("For more rugged terrain,
// Honestly, our boots are more lifestyle..."). Strip them but keep
// the surrounding sentence intact. Merchant trace 2026-05-13 12:12:40.
const FILLER_INTENSIFIER_RE =
  /(?<=^|[\s,;:—–-])(?:Honestly|Frankly|Truthfully|Quite honestly|To be honest|In all honesty)\s*,\s*/gi;

export function stripFillerIntensifiers(text) {
  if (!text) return text;
  return text.replace(FILLER_INTENSIFIER_RE, "").replace(/\s{2,}/g, " ").trim();
}

// Capability-check detector. When the customer asks about prior
// products with phrasings like "are they good for X?", "do they work
// for Y?", "can they handle Z?", they're asking about the PREVIOUS
// turn's cards — not making a new shopping request. The bot should
// answer textually without re-searching and showing different cards
// (merchant trace 2026-05-13 12:12:35: customer asked "are they good
// for mountain climbing?" referring to prior sneakers; bot answered
// correctly in text but ALSO searched for boots and showed 6 boot
// cards underneath — text-card mismatch).
const CAPABILITY_CHECK_RE =
  /^\s*(?:are\s+(?:they|these|those|it|this)|is\s+(?:it|this|that)|do\s+(?:they|these|those)|does\s+(?:it|this|that)|can\s+(?:they|these|those|it|this)|will\s+(?:they|these|those|it|this)|would\s+(?:they|these|those|it|this)|how\s+(?:do|does|are|is)\s+(?:they|these|those|it|this))\b/i;

export function isCapabilityCheckAboutPriorProducts(text) {
  if (!text || typeof text !== "string") return false;
  return CAPABILITY_CHECK_RE.test(text);
}

// Inline-list formatter. The LLM sometimes packs a multi-item list
// into a single run-on paragraph using ` - **Label** — ` separators,
// which the widget renders as one wall of text instead of a bulleted
// list. Detect the pattern (≥2 inline `- **Label** —` markers in
// the same response) and rewrite with newlines so the widget can
// render proper line breaks. Merchant trace 2026-05-13 12:12:48
// ("tell me more about aetrex" → 1061-char wall).
const INLINE_LIST_ITEM_RE = /\s+-\s+(\*\*[^*]{2,40}\*\*)\s+[—–-]\s+/g;

export function reflowInlineList(text) {
  if (!text) return text;
  // Count how many inline list markers exist. We only reflow when
  // there are 2+, otherwise a single mid-sentence " - **X** — " is
  // probably not a list intent.
  const matches = text.match(INLINE_LIST_ITEM_RE);
  if (!matches || matches.length < 2) return text;
  // Insert a newline before each list marker. The widget's markdown
  // renderer turns `\n- **X** — ...` into a proper bullet line.
  return text.replace(INLINE_LIST_ITEM_RE, (_m, label) => `\n- ${label} — `).trim();
}

// Ensure bold section headers (`**Heading**`) start on their own line.
// Live traces 2026-06-08:
//   1. "BioRocker vs UltraSky" → LLM wrote
//      "...sneakers like Darcy **UltraSKY™ Technology**" (header
//      glued onto end of prior bullet's last sentence).
//   2. "...compare: **BioRocker™ Technology**" (header on same line
//      as the lead-in colon).
// Prompt rule alone isn't sticky enough — the LLM emits these
// patterns occasionally. Postprocess to guarantee paragraph break.
//
// Detection: a bold span is treated as a section header when it's
// ≥12 chars OR contains a section keyword (Technology, Method,
// System, Approach, Feature, Series, Line, Collection). Inline
// emphasis ("really", "important", "now") is short and never
// contains those keywords, so it doesn't trip this.
const SECTION_HEADER_KEYWORD_RE = /\b(?:Technology|Method|System|Feature|Approach|Series|Line|Collection)\b/i;

export function ensureHeaderLineBreaks(text) {
  if (!text || typeof text !== "string") return text;
  // Normalize line endings up front. \r\n inputs make the patterns
  // miss because [^\n] still matches \r, and downstream string-splits
  // on \n\n produce garbage on CRLF documents.
  let next = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n");
  // Pattern 1: After a colon ("compare:" / "summary:" / etc.) →
  // promote same-line bold to a fresh paragraph.
  next = next.replace(/(:)[ \t]+(\*\*[A-Z][^*\n]{2,}\*\*)/g, "$1\n\n$2");
  // Pattern 2: Long bold span (≥12 chars excluding the `**`) preceded
  // by non-newline content on same line. Length is a strong signal for
  // section header (inline emphasis is almost always short).
  next = next.replace(
    /([^\n*])([ \t]+)(\*\*[A-Z][^*\n]{11,}\*\*)/g,
    (_m, prev, _ws, header) => `${prev}\n\n${header}`,
  );
  // Pattern 3: Shorter bold span (3–11 chars) preceded by content
  // on same line, but only when it contains a section keyword. Catches
  // "**Tech**" or "**Method 2**".
  next = next.replace(
    /([^\n*])([ \t]+)(\*\*([A-Z][^*\n]{2,10})\*\*)/g,
    (m, prev, _ws, header, inner) =>
      SECTION_HEADER_KEYWORD_RE.test(inner) ? `${prev}\n\n${header}` : m,
  );
  // Pattern 4: Bold header on its OWN line but preceded by a single \n
  // (content immediately above with no blank line). Live trace
  // 2026-06-08: LLM emitted "...the Darcy sneaker\n**UltraSKY™
  // Technology**\nA lightweight..." — the header was on its own line
  // but glued to the prior bullet by a single newline, so markdown
  // renders the whole thing as ONE paragraph. Promote to blank line.
  next = next.replace(
    /([^\n])\n(\*\*[A-Z][^*\n]{11,}\*\*)/g,
    (_m, prev, header) => `${prev}\n\n${header}`,
  );
  next = next.replace(
    /([^\n])\n(\*\*([A-Z][^*\n]{2,10})\*\*)/g,
    (m, prev, header, inner) =>
      SECTION_HEADER_KEYWORD_RE.test(inner) ? `${prev}\n\n${header}` : m,
  );
  // Pattern 5: Same header on own line, FOLLOWED by content on next
  // line with single \n (no blank line after). The markdown widget
  // needs blank line after the header too, otherwise the next sentence
  // gets read as a continuation of the header line.
  next = next.replace(
    /(\*\*[A-Z][^*\n]{11,}\*\*)\n([^\n])/g,
    (_m, header, next2) => `${header}\n\n${next2}`,
  );
  next = next.replace(
    /(\*\*([A-Z][^*\n]{2,10})\*\*)\n([^\n])/g,
    (m, header, inner, next2) =>
      SECTION_HEADER_KEYWORD_RE.test(inner) ? `${header}\n\n${next2}` : m,
  );
  return next;
}

// Tighten sequential single-line "Label: Value" paragraphs into a
// proper bullet list. Live trace 2026-06-08: comparing Jillian and
// Danika, the LLM emitted each spec as its own paragraph:
//   **Jillian Braided Quarter Strap Sandal — $139.95**
//
//   Category: Sandal
//
//   Closure: Hook & loop adjustable straps
//
//   Upper: Genuine leather...
// The widget renders each paragraph with vertical margin → wide gaps.
// Convert sequential short "Label: Value" paragraphs that follow a
// bold header into a tight bulleted list. The widget renders adjacent
// bullets with less vertical space.
const FACT_LINE_RE = /^\s*([A-Z][A-Za-z][\w ]{1,30}):\s+([^\n]{2,180})\s*$/;
// Existing bullet line: starts with "- " or "* " then content.
const BULLET_LINE_RE = /^\s*[-*][ \t]+([^\n]+)\s*$/;
export function tightenSequentialFactLines(text) {
  if (!text || typeof text !== "string") return text;
  // Normalize line endings and any blank-line whitespace so the
  // \n\n splitter sees real paragraph boundaries. Without this, \r\n
  // inputs or " \n " whitespace-only "blank" lines break the splitter
  // and the function returns garbage (header stripped, items spaced
  // wrong).
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n");
  const blocks = normalized.split(/\n{2,}/);
  if (blocks.length < 4) return text;
  const out = [];
  let factsInRow = 0;
  let lastWasHeader = false;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) {
      out.push(blocks[i]);
      continue;
    }
    const isHeader = /^\*\*[A-Z][^*\n]{2,}\*\*$/.test(block);
    const factMatch = block.match(FACT_LINE_RE);
    // Bullet detection: single-line bullet OR a block where ALL lines
    // are bullets (multi-line bullet block from prior turn). When the
    // LLM emits "- item\n\n- item\n\n- item" each item lands in its
    // own \n\n-split block. Promote to a tight bullet block.
    const bulletMatch = block.match(BULLET_LINE_RE);
    if (isHeader) {
      out.push(block);
      lastWasHeader = true;
      factsInRow = 0;
    } else if (factMatch && (lastWasHeader || factsInRow > 0)) {
      const label = factMatch[1].trim();
      const value = factMatch[2].trim();
      out.push(`__FACT__- **${label}:** ${value}`);
      factsInRow += 1;
      lastWasHeader = false;
    } else if (bulletMatch && (lastWasHeader || factsInRow > 0)) {
      // Adjacent bullet under a section — collapse \n\n separator
      // to single \n so the widget renders a tight bullet list, not
      // paragraph-spaced items. Live trace 2026-06-08: BioRocker vs
      // UltraSky rendered bullets as wide paragraphs because the LLM
      // emitted "- item\n\n- item" with blank lines between.
      out.push(`__FACT__- ${bulletMatch[1].trim()}`);
      factsInRow += 1;
      lastWasHeader = false;
    } else {
      out.push(block);
      lastWasHeader = false;
      factsInRow = 0;
    }
  }
  // Join: facts/bullets separated by single \n; everything else by \n\n.
  let result = "";
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    if (i > 0) {
      const prev = out[i - 1];
      const curIsFact = cur.startsWith("__FACT__");
      const prevIsFact = prev.startsWith("__FACT__");
      if (curIsFact && prevIsFact) result += "\n";
      else result += "\n\n";
    }
    result += cur.replace(/^__FACT__/, "");
  }
  return result;
}

// Word-boundary truncation. The previous cap could chop mid-word
// ("casual-wea..." in production trace 2026-05-13 12:12:40). Given
// the desired soft maximum (e.g., 300 chars), walk back to the
// nearest sentence-end OR word boundary so the truncated text reads
// cleanly. Adds an ellipsis only when the cut is mid-thought
// (no sentence-end found nearby).
export function truncateAtWordBoundary(text, softCap, lookAhead = 400) {
  if (!text || text.length <= softCap) return text;
  // First, look for a sentence-end at or shortly after the cap.
  const tail = text.slice(softCap, softCap + lookAhead);
  const sentenceEndRel = tail.search(/[.!?](\s|$)/);
  if (sentenceEndRel >= 0) {
    return text.slice(0, softCap + sentenceEndRel + 1).trim();
  }
  // No sentence-end nearby. Walk BACK from softCap to the last
  // space — never split a word in the middle.
  const head = text.slice(0, softCap);
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > softCap * 0.6) {
    return head.slice(0, lastSpace).trim() + "…";
  }
  // Fallback: cut at softCap (only when no good word boundary exists,
  // e.g., text is one huge word — vanishingly rare).
  return head.trim() + "…";
}

// When the AI ends a turn without searching but its response implies
// "we don't have X", that's almost always wrong (the AI hallucinated
// unavailability from training data). Detect the pattern; the caller
// can use it to force a search hop OR (production trace 2026-05-13)
// strip a self-contradicting response.
//
// Controlled-OOS exception (merchant rule): when the AI tells the
// customer a specific named product is "currently out of stock" AND
// directs them to a back-in-stock signup, that's an INTENTIONAL,
// useful answer — not a hallucination. We let those through.
const AVAILABILITY_DENIAL_RE = /\b(?:we|i|the (?:store|shop)) (?:don'?t|do not|cannot|can'?t)\s+(?:have|carry|sell|stock|offer|see|find)\b|\b(?:not (?:available|in stock|carried)|out of stock|couldn'?t find|don'?t see (?:any|that|those|it))\b|\bwe don'?t (?:appear to|seem to)|\bneither\s+\S[^.!?\n]{1,120}?\s+(?:appears?|seems?|is|are)\s+(?:to be\s+)?(?:available|in stock)\b|\bdoesn'?t\s+appear\s+(?:to be\s+)?(?:available|in stock)\b|\bappears? (?:to be\s+)?(?:no longer|currently un|sold out)/i;
const ALLOWED_OOS_SIGNAL_RE = /\b(?:back[- ]?in[- ]?stock|notify\s+(?:me|you)|sign\s+up\s+for|email\s+alerts?|product\s+page|when\s+(?:it'?s|it\s+is|they(?:'re|\s+are))\s+back)\b/i;

export function containsAvailabilityDenial(text) {
  if (!text) return false;
  if (!AVAILABILITY_DENIAL_RE.test(text)) return false;
  if (ALLOWED_OOS_SIGNAL_RE.test(text)) return false;
  return true;
}

export function stripBannedNarration(text) {
  if (!text) return text;
  return text
    .replace(SELF_CORRECTION_RE, " ")
    .replace(REASONING_LEAK_RE, " ")
    .replace(TOOL_NARRATION_RE, " ")
    .replace(BANNED_NARRATION, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Pitch-shaped text: AI claiming a recommendation is being made (with
// or without an actual product card). Used to detect incoherent turns
// where the AI announces a match but no product was returned.
//
// IMPORTANT: this regex must NOT match common transition acks ("got
// it", "okay", "alright"). Those appear in tons of legitimate
// chip-answered turns (e.g. "Got it — for training, you'll want…")
// which precede a tool call on the next hop. Including them caused
// the empty-pool repair to fire on every chip-click turn and
// replace the AI's actual question with a generic "nothing's
// hitting" recovery — broke the flow entirely. Stick to phrases
// that genuinely imply a product pitch ("here are", "top picks",
// "perfect match" etc).
const PRODUCT_PITCH_RE = /\b(here (?:are|is)|here's|check out|check these|some great|great options|top picks|picks for you|styles for you|perfect (?:for|match|pick|choice)|the (?:best|ideal|right) (?:match|choice|pick|option)|i (?:recommend|suggest)|points to|cleat-?compatible|look that up)\b/i;

export function looksLikeProductPitch(text) {
  return Boolean(text) && PRODUCT_PITCH_RE.test(text);
}

// Detect a "definitional hallucination" — sentences like "X is our
// premium orthotic line that..." where the model made up information
// about a brand/product/term that isn't in the catalog (and didn't
// turn up in search). Used after a search returned 0 results to catch
// the AI confidently describing something we didn't validate.
//
// Returns true if the text contains a likely definitional sentence
// pattern. Heuristic — false positives are acceptable since the
// fallback is "I'd love to help — can you give me more detail?"
const DEFINITIONAL_RE = /\b(?:[A-Z][\w-]{2,}\s+(?:is|are)\s+(?:our|an?|the)\s+(?:premium|signature|exclusive|new|advanced|patented|proprietary|flagship|line|technology|orthotic|insole|footbed|brand|collection|series))\b/;

export function looksLikeDefinitionalHallucination(text) {
  return Boolean(text) && DEFINITIONAL_RE.test(text);
}

// Multi-gender chip answer parsing. "Men's & Boys'" → "men". "Women's,
// Girls'" → "women". Single-gender values return as-is.
export function normalizeGenderChipAnswer(raw) {
  const tokens = String(raw || "")
    .toLowerCase()
    .split(/\s*(?:&|,|\band\b|\+|\/)\s*/)
    .map((t) => t.replace(/['‘’]/g, "").trim())
    .filter(Boolean);
  for (const t of tokens) {
    if (["men", "mens", "male", "boy", "boys"].includes(t)) return "men";
    if (["women", "womens", "female", "girl", "girls"].includes(t)) return "women";
  }
  return null;
}

export function hasChoiceButtons(text) {
  return /<<[^<>]+>>/.test(text || "");
}

// Detect singular-prescriptive AI language — when the AI claims ONE
// specific product is "the right pick" / "the go-to choice" / "would
// be perfect" / etc. Used by chat.jsx to narrow card rendering to a
// single product so text and card agree. Patterns intentionally
// generous: a false positive (narrowing to 1 card on softer language)
// is better than a false negative (showing 3 cards under singular AI
// text, which feels incoherent to the customer).
const SINGULAR_PRESCRIPTIVE = /\b(?:is (?:your|the) (?:best|perfect|ideal|top|right|go-?to) (?:match|choice|pick|fit|one|option)|is (?:a |an )?(?:great|perfect|good|ideal|solid) (?:match|choice|pick|fit|option)|is the one for you|would be (?:a (?:great|good|perfect|solid))? ?(?:match|choice|pick|fit|option)|i'?d (?:recommend|suggest)|i (?:recommend|suggest) (?:the|trying|going with))\b/i;

export function isSingularPrescriptive(text) {
  return Boolean(text) && SINGULAR_PRESCRIPTIVE.test(text);
}

// Plural-intro framing — the AI is presenting MULTIPLE options at once
// instead of recommending one. When this framing is present, the
// downstream score-threshold filter (which checks how many of each
// card's distinctive title words appear in the AI text) under-counts:
// a generic intro like "Here are some great wedges" doesn't repeat
// each product name, so most cards fall below the threshold and the
// customer sees fewer cards than the text promises ("Both of these
// wedges…" rendering 1 card). Catch the framing here so chat.jsx can
// skip the threshold and render the full pool. Vocabulary-agnostic —
// works for any catalog vertical.
const PLURAL_INTRO_FRAMING = /\b(?:here are|here'?s a (?:few|couple|handful)|here'?s (?:a|an|some|our|the|several)?\s*(?:\w+\s+)?(?:lineup|selection|mix|range|variety|collection|assortment|set of|list of|roundup)|here'?s what (?:i|we) (?:found|got|recommend)|both of (?:these|them)|these (?:are|two|three|few|options)|some great|several (?:great )?(?:options|picks|choices)|a few (?:options|picks|choices)|check out (?:these|some)|take a look at (?:these|some)|i'?d recommend|i recommend|i'?ve (?:got|pulled|found))\b/i;

export function hasPluralIntroFraming(text) {
  return Boolean(text) && PLURAL_INTRO_FRAMING.test(text);
}

// AI ships repetitive sentences in two distinct shapes:
//   (a) Echo opener — two adjacent sentences starting with the same
//       4+ words ("Here are some great X. Here are some great X with…").
//   (b) Paraphrase — two adjacent sentences that say the same thing
//       in different words ("The standard version provides cushioning
//       and arch support... The standard Kids Orthotics offer
//       cushioning and arch support...").
//
// Both violate the NO REPETITION prompt rule but the AI keeps shipping
// them. Catch both: first by opener match (cheap, narrow), then by
// content overlap (Jaccard-style, broader).
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for",
  "with", "as", "by", "is", "are", "be", "been", "being", "was", "were",
  "this", "that", "these", "those", "it", "its", "your", "you", "we", "our",
  "i", "me", "my", "if", "while", "when", "what", "which", "who", "whose",
  "than", "then", "so", "also", "just", "too", "very", "any", "some", "all",
  "more", "most", "less", "no", "not", "do", "does", "did", "have", "has",
  "had", "from", "into", "out", "up", "down", "over", "under", "between",
]);

function significantWords(s) {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function overlapRatio(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

// URL extractor for the cross-sentence URL-repeat guard. Catches bare
// domains too (aetrex.com/pages/...) since the AI often pastes URLs
// without a scheme.
const URL_RE = /\bhttps?:\/\/\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi;

function extractUrls(text) {
  const out = new Set();
  let m;
  const re = new RegExp(URL_RE.source, "gi");
  while ((m = re.exec(text)) !== null) {
    // Strip trailing punctuation (period, comma, etc.) the regex may
    // have swept up.
    out.add(m[0].replace(/[.,;:!?)]+$/, "").toLowerCase());
  }
  return out;
}

// Strip "lineup promise" phrases when cards have been suppressed
// (chip-question turn). The LLM sometimes writes "Here's the full
// women's lineup — they come in standard, posted, and metatarsal
// variants, all at $74.95–$79.95" alongside a clarifying chip
// question. The chip-suppression strips the cards, so the customer
// reads a promise of products that never appear. This strip cleans
// up the orphaned promise so the response reads as a clean
// definitional answer + the chip question. Merchant trace:
// 2026-05-13 12:02:14.
const LINEUP_PROMISE_SENTENCE_RE = new RegExp(
  [
    String.raw`(?<=^|\s)Here'?s\s+(?:the|our|a|an|some)?\s*(?:full\s+|entire\s+|complete\s+)?(?:[\w'-]+\s+){0,3}(?:lineup|line[- ]up|selection|range|variety|collection|assortment|list|roundup|options|variants|styles|picks)\b[^.!?\n]*[.!?]\s*`,
    String.raw`(?<=^|\s)Here\s+are\s+(?:the|our|some|a few|the (?:full|entire|complete))\s+(?:[\w'-]+\s+){0,3}(?:variants?|options?|styles?|picks?|choices?|lineup|line[- ]up|selection)\b[^.!?\n]*[.!?]\s*`,
    String.raw`(?<=^|\s)(?:They|These|All)\s+come\s+in\s+(?:[\w'-]+,?\s+){1,8}(?:variants?|options?|styles?|sizes?|configurations?)\b[^.!?\n]*[.!?]\s*`,
    String.raw`(?<=^|\s)(?:all\s+|each\s+|both\s+)?(?:priced\s+(?:at|from)|starting\s+(?:at|from)|ranging\s+from|all\s+at|all\s+for|from)\s+\$\d+(?:\.\d+)?[^.!?\n]*[.!?]\s*`,
    String.raw`(?<=^|\s)(?:I[''']ll|let me|I[''']m going to)\s+(?:show|pull|grab|fetch|surface|share|display|present)\s+(?:you\s+)?(?:these|those|them|the (?:lineup|line[- ]up|options|picks|matches))\b[^.!?\n]*[.!?]\s*`,
  ].join("|"),
  "gi",
);

export function stripLineupPromiseSentences(text) {
  if (!text) return text;
  const cleaned = text
    .replace(LINEUP_PROMISE_SENTENCE_RE, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s—\-–,;:]+/, "")
    .trim();
  return cleaned.length >= 20 ? cleaned : text; // bail if the strip wiped almost everything
}

export function dedupeConsecutiveSentences(text) {
  if (!text) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 1) return text;
  const kept = [];
  const allKeptWords = []; // every prior kept sentence's significantWords()
  const seenUrls = new Set();
  let lastOpener = null;
  let lastWords = null;
  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    const tokens = trimmed.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const opener = tokens.slice(0, 4).join(" ");
    const words = significantWords(trimmed);

    if (kept.length > 0) {
      // (a) Echo-opener with the IMMEDIATE predecessor: same first 4 words.
      if (opener && opener === lastOpener) continue;
      // (b) Paraphrase with the IMMEDIATE predecessor: ≥70% overlap.
      if (words.size >= 5 && lastWords && lastWords.size >= 5) {
        const ratio = overlapRatio(words, lastWords);
        if (ratio >= 0.7) continue;
      }
      // (c) URL repeat ACROSS any prior sentence (merchant trace
      //     2026-05-13 11:55:10: bot repeated the same GovX URL twice
      //     in different phrasings within the same response — same
      //     fact restated, looked sloppy). If this sentence introduces
      //     a URL we've already cited AND shares ≥40% significant
      //     words with that earlier sentence, drop it.
      const urls = extractUrls(trimmed);
      let urlDuplicate = false;
      for (const u of urls) {
        if (seenUrls.has(u)) { urlDuplicate = true; break; }
      }
      if (urlDuplicate && words.size >= 5) {
        let maxRatio = 0;
        for (const prev of allKeptWords) {
          if (prev.size < 5) continue;
          const r = overlapRatio(words, prev);
          if (r > maxRatio) maxRatio = r;
        }
        if (maxRatio >= 0.4) continue;
      }
      // (d) Cross-sentence paraphrase: ≥70% overlap with ANY prior
      //     kept sentence (not just the immediate predecessor). The
      //     LLM sometimes restates the same fact two sentences apart.
      if (words.size >= 5) {
        let dup = false;
        for (const prev of allKeptWords) {
          if (prev.size < 5) continue;
          if (overlapRatio(words, prev) >= 0.7) { dup = true; break; }
        }
        if (dup) continue;
      }
    }

    kept.push(trimmed);
    allKeptWords.push(words);
    for (const u of extractUrls(trimmed)) seenUrls.add(u);
    lastOpener = opener;
    lastWords = words;
  }
  return kept.join(" ");
}

// Strip meta-narration where the AI talks ABOUT the customer ("the
// customer already established Men's via the choice button…") or
// dumps its reasoning chain ("we know: orthotic insert, ball of foot
// pain, cleats —"). Customer-facing text should address them in
// second person and just answer.
//
// Three patterns:
//   1. Leading meta-clauses: "Since the customer…", "Given that we
//      know…" up to the first sentence-end or em-dash.
//   2. Mid-text "we know: X, Y, Z —" inventory dumps.
//   3. Third-person references "the customer" / "the user" — replace
//      with "you" so the rest of the sentence stays grammatical.
const META_PREAMBLE_RE = /(?:^|(?<=[.!?]\s+))(?:since|given|considering|because|based on)[^.!?\n,]{0,120}?(?:the\s+customer|the\s+user|via\s+the\s+choice\s+button|already\s+established|already\s+chose|already\s+selected|already\s+picked|already\s+told\s+me)[^.!?\n—,]*[.!?—,]\s*/gi;
const INVENTORY_DUMP_RE = /(?:^|\s|—\s*)(?:and\s+)?we\s+know\s*:?\s*[^.!?—\n]*[—.!?]\s*/gi;
const THIRD_PERSON_CUSTOMER_RE = /\bthe\s+(?:customer|user)\s+(?:has|is|already|wants|needs|said|told|chose|picked|selected|established|mentioned|asked)/gi;
const THIRD_PERSON_BARE_RE = /\bthe\s+(customer|user)\b/gi;

export function stripMetaNarration(text) {
  if (!text) return text;
  let out = text;
  out = out.replace(META_PREAMBLE_RE, " ");
  out = out.replace(INVENTORY_DUMP_RE, " ");
  out = out.replace(THIRD_PERSON_CUSTOMER_RE, (m) =>
    m.replace(/\bthe\s+(?:customer|user)\s+/i, "you "),
  );
  out = out.replace(THIRD_PERSON_BARE_RE, "you");
  return out.replace(/\s{2,}/g, " ").replace(/^\s*[—–-]\s*/, "").trim();
}

// Detect a product-shopping condition (medical / fit problem) or
// occasion (situation the customer needs the product for) in free-
// text. Used by the chat route to recover from the failure mode
// where the AI generates pitch text without ever calling
// search_products — when the user mentioned something searchable
// like "plantar fasciitis" or "trip to Italy", we force a retry
// that searches with the matched phrase as the query.
//
// Vocabulary is footwear/wellness-leaning since that's the dominant
// merchant audience today. Generalize via admin config later if a
// non-footwear merchant needs different keywords.
const CONDITION_RE = /\b(plantar fasciitis|bunion(?:s)?|flat feet|flat foot|fallen arches?|heel pain|heel spurs?|metatarsal(?:gia)?|neuropathy|diabet(?:es|ic)|high arches?|low arches?|arch pain|morton'?s neuroma|achilles|tendon(?:itis)?|supination|overpronation|knee pain|back pain|ankle pain|foot pain|ball[\s-]of[\s-]foot)\b/i;
const OCCASION_RE = /\b(vacation|trip|travel|traveling|cruise|wedding|standing all day|on my feet|running|walking|hiking|gym|workout|everyday|casual|dressy|formal|outdoor|work shoes|office)\b/i;

export function detectConditionOrOccasion(text) {
  if (!text) return null;
  const source = String(text);
  const cm = source.match(CONDITION_RE);
  if (cm) return { kind: "condition", phrase: cm[0].toLowerCase() };
  const om = source.match(OCCASION_RE);
  if (om) return { kind: "occasion", phrase: om[0].toLowerCase() };
  return null;
}
