// LABELED ACCURACY CORPUS — ground-truth routing/ownership labels for a
// representative spread of customer turns. This is the measurement set behind
// scripts/eval-accuracy-scoreboard.mjs: each case is what the engine SHOULD do,
// hand-labeled independent of what planTurn currently returns. The scoreboard
// reports the % the engine gets right, per dimension and overall.
//
// What this measures: the DETERMINISTIC layer — TurnPlan workflow classification,
// clarify/display policy, gender resolution, and the product-truth detectors.
// It does NOT measure live LLM wording quality (that needs the API + a rubric).
//
// Each case:
//   id        unique slug
//   message   the customer's turn
//   ctx       optional planTurn inputs (hasPriorCards, priorCardFamilies, attrs,
//             namedProduct, focusProduct, priorAssistantText)
//   expect    any subset of:
//               workflow    string | string[]  (acceptable workflow(s))
//               clarify     boolean            (clarificationAllowed)
//               display     string             (productDisplayPolicy)
//               forcesCards boolean            (planForcesProductDisplay)
//               gender      "men"|"women"|"kids"|null
//               broadGender boolean            (isBroadGenderRequest)
//               compatTruth boolean            (isOrthoticSandalCompatibilityQuestion)
//   tags      grouping labels for per-tag accuracy
//
// Grow this set as new real turns arrive — that is how the accuracy number
// becomes trustworthy.

export const CASES = [
  // ── condition / advisory ────────────────────────────────────────────────
  { id: "cond-standing", message: "Show me supportive shoes for standing all day",
    expect: { workflow: "condition_recommendation", clarify: false, display: "show", forcesCards: true }, tags: ["condition"] },
  { id: "cond-plantar-walk", message: "What's good for plantar fasciitis and walking?",
    expect: { workflow: "condition_recommendation", clarify: false, forcesCards: true }, tags: ["condition"] },
  { id: "cond-styling", message: "what shoes go with a black dress?",
    expect: { workflow: "browse", forcesCards: true }, tags: ["browse", "styling"] },

  // ── multi_recommendation ────────────────────────────────────────────────
  { id: "multi-shoes-orthotics", message: "I have plantar fasciitis and flat feet. Should I buy shoes, orthotics, or both?",
    expect: { workflow: ["multi_recommendation", "condition_recommendation"], clarify: false, forcesCards: true }, tags: ["multi"] },
  // Both are valid card-showing condition responses; the live engine's
  // classifier attrs tip it to multi, planTurn-standalone lands on condition.
  { id: "multi-vacation", message: "I have plantar fasciitis and want sandals for vacation. Should I get shoes, orthotics, or both?",
    expect: { workflow: ["multi_recommendation", "condition_recommendation"], clarify: false, forcesCards: true }, tags: ["multi"] },

  // ── compatibility / product-truth ───────────────────────────────────────
  { id: "compat-sandal-q", message: "Can I wear orthotics inside sandals, or do I need closed shoes?",
    expect: { workflow: "compatibility", clarify: false, display: "suppress", compatTruth: true }, tags: ["compatibility", "product-truth"] },
  { id: "compat-removable-footbed", message: "Do any Aetrex sandals have removable footbeds for orthotics?",
    expect: { compatTruth: true }, tags: ["compatibility", "product-truth"] },
  { id: "compat-named", message: "Will my orthotics fit in the Jillian?", ctx: { namedProduct: true },
    expect: { workflow: "compatibility", clarify: false }, tags: ["compatibility"] },

  // ── availability (named + follow-up) ─────────────────────────────────────
  { id: "avail-named-wide", message: "is the Savannah available in size 7 wide?", ctx: { namedProduct: true },
    expect: { workflow: "availability", forcesCards: true }, tags: ["availability"] },
  { id: "avail-color-named", message: "does the Drew come in black?", ctx: { namedProduct: true },
    expect: { workflow: "availability", forcesCards: true }, tags: ["availability"] },
  { id: "avail-focus-size", message: "what about size 9?", ctx: { focusProduct: { title: "Savannah Sandal - Champagne" }, hasPriorCards: true },
    expect: { workflow: "availability", forcesCards: true }, tags: ["availability"] },

  // ── prior_evidence_availability (set follow-up) ──────────────────────────
  { id: "prior-wide", message: "What about wide widths?", ctx: { hasPriorCards: true, priorCardFamilies: ["Reagan", "Sandra", "Maui"], attrs: { gender: "women" } },
    expect: { workflow: "prior_evidence_availability", display: "show_availability", forcesCards: true, gender: "women" }, tags: ["prior-evidence"] },
  { id: "prior-black", message: "do those come in black?", ctx: { hasPriorCards: true, priorCardFamilies: ["Reagan", "Sandra", "Maui"], attrs: { gender: "women" } },
    expect: { workflow: "prior_evidence_availability", display: "show_availability", forcesCards: true }, tags: ["prior-evidence"] },

  // ── comparison ──────────────────────────────────────────────────────────
  { id: "cmp-two", message: "compare the Reagan and the Drew", ctx: { namedProduct: true },
    expect: { workflow: "comparison", forcesCards: true }, tags: ["comparison"] },
  { id: "cmp-which-better", message: "which is better for arch support, the first or second one?", ctx: { hasPriorCards: true },
    expect: { workflow: "comparison", forcesCards: true }, tags: ["comparison"] },

  // ── named_product_advisory ───────────────────────────────────────────────
  { id: "named-styling", message: "i want to wear gabby with a short white dress", ctx: { namedProduct: true },
    expect: { workflow: "named_product_advisory", display: "show_focused", forcesCards: true }, tags: ["named"] },
  { id: "named-good", message: "is the Reagan a good everyday shoe?", ctx: { namedProduct: true },
    expect: { workflow: "named_product_advisory", forcesCards: true }, tags: ["named"] },

  // ── product_focus / cart_handoff ─────────────────────────────────────────
  { id: "focus-ordinal", message: "I like the second one", ctx: { focusProduct: { title: "Danika Sneaker" }, hasPriorCards: true },
    expect: { workflow: "product_focus", forcesCards: true }, tags: ["focus"] },
  { id: "cart-add", message: "add it to my cart", ctx: { focusProduct: { title: "Danika Sneaker" }, hasPriorCards: true },
    expect: { workflow: "cart_handoff", forcesCards: true }, tags: ["cart"] },

  // ── display_recovery ─────────────────────────────────────────────────────
  { id: "recover-cantsee", message: "i can't see any", ctx: { hasPriorCards: true, priorAssistantText: "Here are our women's supportive walking shoes." },
    expect: { workflow: "display_recovery", forcesCards: true }, tags: ["recovery"] },

  // ── browse / refinements ─────────────────────────────────────────────────
  { id: "browse-broad-men", message: "Show me men's options", ctx: { hasPriorCards: true, attrs: { gender: "men" } },
    expect: { workflow: "browse", gender: "men", forcesCards: true, broadGender: true }, tags: ["browse", "broad-gender"] },
  { id: "browse-broad-women", message: "what do you have for women", ctx: { hasPriorCards: true },
    expect: { workflow: "browse", broadGender: true }, tags: ["browse", "broad-gender"] },
  { id: "browse-cat-refine", message: "sandals instead", ctx: { hasPriorCards: true },
    expect: { workflow: "browse", forcesCards: true }, tags: ["browse", "refine"] },
  { id: "browse-gender-refine", message: "women's instead", ctx: { hasPriorCards: true },
    expect: { workflow: "browse", gender: "women", forcesCards: true }, tags: ["browse", "refine"] },
  { id: "browse-specific-cat", message: "show me men's sandals", ctx: { hasPriorCards: true },
    expect: { broadGender: false }, tags: ["browse", "broad-gender"] },

  // ── sale_browse ──────────────────────────────────────────────────────────
  { id: "sale", message: "what's on sale?",
    expect: { workflow: "sale_browse", forcesCards: true }, tags: ["sale"] },

  // ── policy knowledge / private account handoff ───────────────────────────
  { id: "policy-return", message: "What is your return policy?",
    expect: { workflow: "policy_knowledge", display: "suppress", forcesCards: false }, tags: ["policy"] },
  { id: "policy-return-implicit", message: "What if I need to return them?",
    expect: { workflow: "policy_knowledge", display: "suppress", forcesCards: false }, tags: ["policy"] },
  { id: "policy-shipping", message: "How long does shipping take?",
    expect: { workflow: "policy_knowledge", display: "suppress", forcesCards: false }, tags: ["policy"] },
  { id: "cs-cancel", message: "I need to cancel my order",
    expect: { workflow: "account_private_handoff", display: "suppress", forcesCards: false }, tags: ["customer-service"] },
  { id: "cs-damaged", message: "my order arrived and one shoe is damaged, I need a replacement",
    expect: { workflow: "account_private_handoff", display: "suppress", forcesCards: false }, tags: ["customer-service"] },

  // ── sizing_help ──────────────────────────────────────────────────────────
  { id: "sizing-runsmall", message: "do these run small?", ctx: { hasPriorCards: true },
    expect: { display: "suppress" }, tags: ["sizing"] },

  // ── clarification / meta ─────────────────────────────────────────────────
  { id: "meta-confused", message: "wait, that's not what I asked",
    expect: { display: "suppress" }, tags: ["meta"] },
];
