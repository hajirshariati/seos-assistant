// Unit eval for chat post-processing heuristics.
//
// Tests the pure functions extracted from chat.jsx into
// chat-postprocessing.js, plus selected exports from
// chat-helpers.server.js. Catches the chat.jsx-side bugs that don't
// live in the gate or classifier — singular-narrow misfires,
// follow-up suggestion validation, pivot-phrasing detection, etc.
//
// Run:
//   node scripts/eval-chat-postprocessing.mjs
//
// Why these matter: the chat.jsx LLM-path has heuristic rules that
// ride on top of the LLM's output. When these rules misfire, the
// customer sees broken UX even though the classifier and gate worked
// correctly. Examples:
//   - Singular-narrow collapses 6 cards → 1 (one specific bug)
//   - Follow-up suggestion promises something the catalog doesn't have
//   - "We don't have X" denial despite the LLM clearly pivoting

import assert from "node:assert/strict";
import {
  detectSingularIntent,
  detectComparisonIntent,
  detectAiPivotPhrasing,
  validateFollowUpSuggestion,
  detectRejectedCategories,
  stripRejectedCategoryChips,
  stripToolCallSyntax,
  detectStockClaim,
  stripStockClaim,
  isYesNoQuestion,
  isYesNoAnswer,
  detectUserSignupIntent,
  detectAiSignupMention,
  scrubRoleMarkers,
  scrubToolCallLeaks,
  detectBroadNeed,
  detectAiNoMatchPhrasing,
  stripDenialLeadIn,
  looksLikeClarifyingQuestion,
  suggestionContradictsGender,
  detectFootwearOverElicitation,
  stripInternalLeaks,
  containsInternalLanguageLeak,
  scrubInternalEnums,
  friendlyEnumLabel,
  isUnanswerableSuggestion,
  resolverPromisedRecommendation,
  stripAvailabilityDenialSentences,
} from "../app/lib/chat-postprocessing.js";
import {
  isSingularPrescriptive,
  hasPluralIntroFraming,
  looksLikeProductPitch,
  looksLikeDefinitionalHallucination,
  hasChoiceButtons,
  normalizeGenderChipAnswer,
  detectConditionOrOccasion,
} from "../app/lib/chat-helpers.server.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err?.message?.split("\n")[0] || err}`);
  }
}

function section(label) {
  console.log(`\n${label}`);
}

// =====================================================================
section("detectSingularIntent");
// =====================================================================

// SHOULD detect as singular
test("'tell me about this'", () => assert(detectSingularIntent("tell me about this")));
test("'tell me more about it'", () => assert(detectSingularIntent("tell me more about it")));
test("'this one'", () => assert(detectSingularIntent("I'll take this one")));
test("'that one'", () => assert(detectSingularIntent("that one looks good")));
test("'what's the best'", () => assert(detectSingularIntent("what's the best for plantar fasciitis")));
test("'which is best'", () => assert(detectSingularIntent("which orthotic is best for athletes")));
test("'the cheapest one'", () => assert(detectSingularIntent("show me the cheapest one")));
test("'the red one'", () => assert(detectSingularIntent("the red one please")));
test("'how about this one' (singular qualifier)", () => assert(detectSingularIntent("how about this one")));
test("'what about that one'", () => assert(detectSingularIntent("what about that one")));

// SHOULD NOT detect as singular
test("'how about for women' (category pivot, NOT singular)", () => assert(!detectSingularIntent("how about for women")));
test("'how about womens' (the production bug)", () => assert(!detectSingularIntent("how about for womens")));
test("'what about kids' (pivot, NOT singular)", () => assert(!detectSingularIntent("what about kids")));
test("'show me sneakers' (plural browse)", () => assert(!detectSingularIntent("show me sneakers under $100")));
test("'find me sandals' (plural browse)", () => assert(!detectSingularIntent("find me sandals")));
test("'do you have boots' (plural browse)", () => assert(!detectSingularIntent("do you have boots in size 10")));

// Comparison overrides singular even if singular phrasing matches
test("'compare X and Y' → not singular", () => assert(!detectSingularIntent("compare the L1 and the L2")));
test("'which is better, X or Y' → not singular", () => assert(!detectSingularIntent("which is better, the L1 or the L2")));
test("'difference between X and Y' → not singular", () => assert(!detectSingularIntent("what's the difference between L1 and L2")));
test("'X vs Y' → not singular", () => assert(!detectSingularIntent("L1 vs L2")));

// =====================================================================
section("detectComparisonIntent");
// =====================================================================

test("'compare X and Y'", () => assert(detectComparisonIntent("compare the L1 and the L2")));
test("'X vs Y'", () => assert(detectComparisonIntent("L1 vs L2")));
test("'X versus Y'", () => assert(detectComparisonIntent("L1 versus L2")));
test("'difference between X and Y'", () => assert(detectComparisonIntent("what's the difference between L1 and L2")));
test("'side-by-side'", () => assert(detectComparisonIntent("show me a side-by-side comparison")));
test("'which is better, X or Y'", () => assert(detectComparisonIntent("which is better, X or Y")));
test("'tell me about X' → NOT comparison", () => assert(!detectComparisonIntent("tell me about the L1")));
test("'show me sandals' → NOT comparison", () => assert(!detectComparisonIntent("show me sandals")));

// =====================================================================
section("detectAiPivotPhrasing");
// =====================================================================

// SHOULD detect as pivot (override saysNoMatch)
test("'we don't have X but here are Y'", () => assert(detectAiPivotPhrasing("We don't have an exact red, but here are our closest")));
test("'but all of these sandals'", () => assert(detectAiPivotPhrasing("We don't have a yellow option, but all of these sandals are tagged for bunions")));
test("'closest options'", () => assert(detectAiPivotPhrasing("Here are our closest options to what you asked for")));
test("'next best alternatives'", () => assert(detectAiPivotPhrasing("These are the next best alternatives we have")));
test("'similar matches'", () => assert(detectAiPivotPhrasing("Here are similar matches we found")));
test("'but I do have'", () => assert(detectAiPivotPhrasing("We don't carry that exact one, but I do have a few options")));
test("'but we've got'", () => assert(detectAiPivotPhrasing("No exact match, but we've got these")));

// SHOULD NOT detect as pivot
test("plain text no pivot", () => assert(!detectAiPivotPhrasing("Here are some sneakers for you")));
test("denial without pivot ('we don't have')", () => assert(!detectAiPivotPhrasing("We don't have any in your size")));
test("'but it's expensive' (not a product pivot)", () => assert(!detectAiPivotPhrasing("That's a great option but it's expensive")));

// =====================================================================
section("validateFollowUpSuggestion");
// =====================================================================

test("plain question allowed", () => {
  const r = validateFollowUpSuggestion("Do you have wider widths?", "Here are some sneakers.");
  assert(r.allowed, `expected allowed, got ${r.reason}`);
});

test("'do you have these in another color' allowed (no tech term)", () => {
  const r = validateFollowUpSuggestion("Do you have these in another color?", "Here are some sneakers.");
  assert(r.allowed, `expected allowed, got ${r.reason}`);
});

test("'tell me about UltraSKY' BLOCKED if not in reply", () => {
  const r = validateFollowUpSuggestion("Tell me more about UltraSKY foam", "Here are some sneakers.");
  assert(!r.allowed, `expected blocked, got allowed`);
});

test("'tell me about UltraSKY' ALLOWED if in reply", () => {
  const r = validateFollowUpSuggestion("Tell me more about UltraSKY foam", "These have UltraSKY cushioning for shock absorption.");
  assert(r.allowed, `expected allowed, got ${r.reason}`);
});

test("spec measurement BLOCKED if not in reply", () => {
  const r = validateFollowUpSuggestion("What's the heel height?", "Here are some sneakers.");
  assert(!r.allowed, `expected blocked, got allowed`);
});

test("spec measurement ALLOWED if in reply", () => {
  const r = validateFollowUpSuggestion("What's the heel height?", "These have a 12mm heel height drop.");
  assert(r.allowed, `expected allowed, got ${r.reason}`);
});

test("'how does the technology work' BLOCKED (deepdive)", () => {
  const r = validateFollowUpSuggestion("How does the foam technology work", "Here are some sneakers.");
  assert(!r.allowed, `expected blocked, got allowed`);
});

test("'explain the system' BLOCKED (deepdive)", () => {
  const r = validateFollowUpSuggestion("Explain the support system", "Here are some sneakers.");
  assert(!r.allowed, `expected blocked, got allowed`);
});

// =====================================================================
section("isSingularPrescriptive (chat-helpers)");
// =====================================================================

test("'X is your perfect match' → prescriptive", () => assert(isSingularPrescriptive("L1320 is your perfect match")));
test("'X is the best fit' → prescriptive", () => assert(isSingularPrescriptive("This sandal is the best fit for you")));
test("'here are some options' → NOT prescriptive", () => assert(!isSingularPrescriptive("here are some options for you")));

// =====================================================================
section("hasPluralIntroFraming (chat-helpers)");
// =====================================================================

test("'here are some sneakers'", () => assert(hasPluralIntroFraming("here are some sneakers for you")));
test("'check out these options'", () => assert(hasPluralIntroFraming("check out these options")));
test("'X is your perfect match' → NOT plural-intro", () => assert(!hasPluralIntroFraming("L1320 is your perfect match")));

// =====================================================================
section("hasChoiceButtons (chat-helpers)");
// =====================================================================

test("'<<Men>><<Women>>' → has buttons", () => assert(hasChoiceButtons("Pick one: <<Men>><<Women>>")));
test("plain text → no buttons", () => assert(!hasChoiceButtons("Here are some sneakers.")));
test("escaped chars → no buttons", () => assert(!hasChoiceButtons("size <S, M, L>")));

// =====================================================================
section("normalizeGenderChipAnswer (chat-helpers)");
// =====================================================================

test("'Men' → 'men'", () => assert.equal(normalizeGenderChipAnswer("Men"), "men"));
test("\"Men's\" → 'men'", () => assert.equal(normalizeGenderChipAnswer("Men's"), "men"));
test("'Women' → 'women'", () => assert.equal(normalizeGenderChipAnswer("Women"), "women"));
test("\"Men's & Boys'\" → 'men' (compound)", () => assert.equal(normalizeGenderChipAnswer("Men's & Boys'"), "men"));

// =====================================================================
section("detectConditionOrOccasion (chat-helpers)");
// =====================================================================

test("'plantar fasciitis' detected", () => {
  const r = detectConditionOrOccasion("I have plantar fasciitis");
  assert(r, `expected truthy, got ${JSON.stringify(r)}`);
});

test("'flat feet' detected", () => {
  const r = detectConditionOrOccasion("my flat feet hurt");
  assert(r, `expected truthy, got ${JSON.stringify(r)}`);
});

test("'wedding' detected", () => {
  const r = detectConditionOrOccasion("I'm going to a wedding");
  assert(r, `expected truthy, got ${JSON.stringify(r)}`);
});

test("greeting → not detected", () => {
  const r = detectConditionOrOccasion("hi how are you");
  assert(!r, `expected falsy, got ${JSON.stringify(r)}`);
});

// =====================================================================
section("detectRejectedCategories");
// =====================================================================

test("'I don't like sandals' → {sandals}", () => {
  const r = detectRejectedCategories("I don't like sandals");
  assert(r.has("sandals"), `expected sandals, got ${[...r].join(",")}`);
});

test("'no boots please' → {boots}", () => {
  const r = detectRejectedCategories("no boots please");
  assert(r.has("boots"));
});

test("'doesn't like shoes' → expands to all footwear members", () => {
  const r = detectRejectedCategories("she doesn't like shoes");
  assert(r.has("sandals") && r.has("sneakers") && r.has("boots") && r.has("loafers"),
    `expected umbrella expansion, got ${[...r].join(",")}`);
});

test("'do not want boots' → {boots}", () => {
  const r = detectRejectedCategories("I do not want boots");
  assert(r.has("boots"), `expected boots, got ${[...r].join(",")}`);
});

test("'something other than sneakers' → {sneakers}", () => {
  const r = detectRejectedCategories("something other than sneakers");
  assert(r.has("sneakers"));
});

test("'is not good for flat feet' → empty (evaluation phrase, NOT rejection)", () => {
  // Production false-positive: "but L2305 is not good for flat feet"
  // was adding "flat" and "orthotic" to rejectedCategories. Tighten
  // the regex so bare "not" + evaluation phrasing doesn't count as
  // a category rejection.
  const r = detectRejectedCategories("but L2305 is not good for flat feet");
  assert.equal(r.size, 0, `expected no rejections from evaluation phrasing; got ${[...r].join(",")}`);
});

test("'this one doesn't fit my orthotic insole' → empty (not a rejection)", () => {
  // Customer complaining about fit, not rejecting orthotics
  const r = detectRejectedCategories("this one doesn't fit my orthotic insole");
  assert.equal(r.size, 0, `expected no rejections; got ${[...r].join(",")}`);
});

test("'no, my feet are flat' → empty (flat is anatomy, not flats category)", () => {
  const r = detectRejectedCategories("no, my feet are flat");
  assert.ok(!r.has("flat") && !r.has("flats"), `'flat' alone must not be parsed as the flats category; got ${[...r].join(",")}`);
});

test("'avoid heels' → {heels}", () => {
  const r = detectRejectedCategories("avoid heels");
  assert(r.has("heels"));
});

test("'I love sandals' → no rejection", () => {
  const r = detectRejectedCategories("I love sandals");
  assert.equal(r.size, 0, `expected empty, got ${[...r].join(",")}`);
});

test("empty / null → empty Set", () => {
  assert.equal(detectRejectedCategories("").size, 0);
  assert.equal(detectRejectedCategories(null).size, 0);
});

// =====================================================================
section("stripRejectedCategoryChips");
// =====================================================================

test("strips matching chip", () => {
  const r = stripRejectedCategoryChips("Try these: <<Sandals>><<Sneakers>>", new Set(["sandals"]));
  assert(!r.text.includes("<<Sandals>>"), `expected sandals stripped, got ${r.text}`);
  assert(r.text.includes("<<Sneakers>>"));
  assert.deepEqual(r.stripped, ["Sandals"]);
});

test("plural/singular stem matching", () => {
  const r = stripRejectedCategoryChips("<<Boot>><<Boots>>", new Set(["boots"]));
  assert.equal(r.stripped.length, 2, `expected both stripped, got ${r.stripped.length}`);
});

test("case-insensitive match", () => {
  const r = stripRejectedCategoryChips("<<SANDALS>>", new Set(["sandals"]));
  assert.equal(r.stripped.length, 1);
});

test("no rejection → text unchanged", () => {
  const original = "<<Sandals>><<Sneakers>>";
  const r = stripRejectedCategoryChips(original, new Set());
  assert.equal(r.text, original);
  assert.equal(r.stripped.length, 0);
});

test("empty text → empty result", () => {
  const r = stripRejectedCategoryChips("", new Set(["sandals"]));
  assert.equal(r.text, "");
});

// =====================================================================
section("stripToolCallSyntax");
// =====================================================================

test("strips <function_calls> tag", () => {
  const r = stripToolCallSyntax("<function_calls>foo</function_calls>Hello.");
  assert(!r.includes("<function_calls>"), `got: ${r}`);
  assert(r.includes("Hello."));
});

test("strips <invoke> tag", () => {
  const r = stripToolCallSyntax(`<invoke name="search">x</invoke> Result.`);
  assert(!r.includes("<invoke"), `got: ${r}`);
});

test("strips antml:* tags", () => {
  const r = stripToolCallSyntax("<tool>x</tool> ok");
  assert(!r.includes("<antml"), `got: ${r}`);
});

test("strips 'search_products {...}' fragment", () => {
  const r = stripToolCallSyntax(`search_products {"q":"sandals"} Here are options.`);
  assert(!r.includes("search_products"), `got: ${r}`);
  assert(r.includes("options"));
});

test("strips 'recommend_orthotic {...}' fragment", () => {
  const r = stripToolCallSyntax(`recommend_orthotic {"gender":"Men"} Here it is.`);
  assert(!r.includes("recommend_orthotic"));
});

test("strips bare 'search_products Foo...' leader", () => {
  const r = stripToolCallSyntax("search_products The Casual line is great.");
  assert(!r.startsWith("search_products"), `got: ${r}`);
});

test("clean text passes through", () => {
  const r = stripToolCallSyntax("Just regular reply.");
  assert.equal(r, "Just regular reply.");
});

test("null/undefined safe", () => {
  assert.equal(stripToolCallSyntax(null), null);
  assert.equal(stripToolCallSyntax(""), "");
});

// =====================================================================
section("detectStockClaim / stripStockClaim");
// =====================================================================

test("'currently available in size 9' → claim detected", () => {
  assert(detectStockClaim("Yes, currently available in size 9 wide."));
});

test("'in stock in size 10' → claim detected", () => {
  assert(detectStockClaim("These are in stock in size 10."));
});

test("'we have it in size 8' → claim detected", () => {
  assert(detectStockClaim("Good news — we have it in size 8."));
});

test("'available in wide' → claim detected", () => {
  assert(detectStockClaim("Available in wide width."));
});

test("plain text → no claim", () => {
  assert(!detectStockClaim("These are great for plantar fasciitis."));
});

test("size mention without availability → no claim", () => {
  assert(!detectStockClaim("They run small — go up half a size."));
});

test("stripStockClaim removes phrase + appends deferral", () => {
  const r = stripStockClaim("Great pick — currently available in size 9 wide.");
  assert(!/available in size/.test(r), `still has claim: ${r}`);
  assert(/can't check live stock/.test(r), `missing deferral: ${r}`);
});

// =====================================================================
section("isYesNoQuestion / isYesNoAnswer");
// =====================================================================

test("'do these come in red?' → yes/no question", () => {
  assert(isYesNoQuestion("do these come in red?"));
});

test("'is it good for plantar fasciitis?' → yes/no question", () => {
  assert(isYesNoQuestion("is it good for plantar fasciitis?"));
});

test("'will it work for me?' → yes/no question", () => {
  assert(isYesNoQuestion("will it work for me?"));
});

test("'show me more' → not a yes/no question", () => {
  assert(!isYesNoQuestion("show me more"));
});

test("'what should I get?' → not a yes/no question (wh-)", () => {
  assert(!isYesNoQuestion("what should I get?"));
});

test("statement → not a yes/no question", () => {
  assert(!isYesNoQuestion("I have plantar fasciitis"));
});

test("'Yes — these have...' → yes/no answer", () => {
  assert(isYesNoAnswer("Yes — these have arch support."));
});

test("'No, unfortunately...' → yes/no answer", () => {
  assert(isYesNoAnswer("No, unfortunately we don't carry those."));
});

test("'Absolutely!' → yes/no answer", () => {
  assert(isYesNoAnswer("Absolutely! These work great."));
});

test("'Here are some options' → not a yes/no answer", () => {
  assert(!isYesNoAnswer("Here are some options for you"));
});

// =====================================================================
section("detectUserSignupIntent / detectAiSignupMention");
// =====================================================================

test("'sign up for newsletter' → user signup intent", () => {
  assert(detectUserSignupIntent("How do I sign up for your newsletter?"));
});

test("'subscribe to your email list' → user signup intent", () => {
  assert(detectUserSignupIntent("subscribe to your email list"));
});

test("'mailing list' → user signup intent", () => {
  assert(detectUserSignupIntent("add me to the mailing list"));
});

test("plain shopping question → no signup intent", () => {
  assert(!detectUserSignupIntent("show me sandals"));
});

test("AI 'subscribe to our newsletter' → mention detected", () => {
  assert(detectAiSignupMention("Subscribe to our newsletter for updates."));
});

test("AI 'join our list' → mention detected", () => {
  assert(detectAiSignupMention("Join our email list."));
});

test("AI plain reply → no signup mention", () => {
  assert(!detectAiSignupMention("Here are some sneakers."));
});

// =====================================================================
section("scrubRoleMarkers");
// =====================================================================

test("strips 'Human:' prefix", () => {
  const r = scrubRoleMarkers("Human: Here's some advice.");
  assert(r.changed, `expected changed`);
  assert(!r.text.includes("Human:"));
});

test("strips 'Assistant:' mid-text", () => {
  const r = scrubRoleMarkers("Hello there. Assistant: more text here.");
  assert(r.changed);
  assert(!r.text.includes("Assistant:"));
});

test("clean text → unchanged", () => {
  const r = scrubRoleMarkers("Plain reply with no leak.");
  assert(!r.changed);
  assert.equal(r.text, "Plain reply with no leak.");
});

test("almost-empty after strip → keeps original", () => {
  const r = scrubRoleMarkers("Human:");
  assert(!r.changed, `should keep original when strip leaves <5 chars`);
  assert.equal(r.text, "Human:");
});

// =====================================================================
section("scrubToolCallLeaks");
// =====================================================================

test("clean text → unchanged", () => {
  const r = scrubToolCallLeaks("Here are some great women's sandals with arch support.");
  assert(!r.changed);
  assert.equal(r.text, "Here are some great women's sandals with arch support.");
});

test("<template_name> + <template_params> block → stripped", () => {
  const r = scrubToolCallLeaks(
    "Got it. <template_name>search_products</template_name> <template_params>{ \"query\": \"women's casual\" }</template_params>"
  );
  assert(r.changed);
  assert(!r.text.includes("template_name"), `should strip template_name: got "${r.text}"`);
  assert(!r.text.includes("template_params"), `should strip template_params: got "${r.text}"`);
  assert(r.text.startsWith("Got it"));
});

test("bare 'search_products { ... }' inline → stripped", () => {
  const r = scrubToolCallLeaks(
    `search_products { "query": "men's dress shoes", "filters": { "gender": "men", "category": "oxfords" } }`
  );
  assert(r.changed);
  assert(!r.text.includes("search_products"), `should strip search_products: got "${r.text}"`);
});

test("<search_products>...</search_products> XML block → stripped", () => {
  const r = scrubToolCallLeaks(
    "We don't have pink sandals. <search_products> <query>sandals bunions</query> <filters>{\"category\": \"Sandals\"}</filters> </search_products>"
  );
  assert(r.changed);
  assert(!r.text.includes("<search_products"), `should strip <search_products>: got "${r.text}"`);
  assert(r.text.includes("We don't have pink sandals"));
});

test("text + tool leak + more text → preserves real content", () => {
  const r = scrubToolCallLeaks(
    "Men's casual shoes range $70-$130. search_products { \"query\": \"men's casual\" } Hope that helps!"
  );
  assert(r.changed);
  assert(r.text.includes("Men's casual shoes range"));
  assert(r.text.includes("Hope that helps"));
  assert(!r.text.includes("search_products"));
});

test("lookup_sku JSON leak → stripped", () => {
  const r = scrubToolCallLeaks('lookup_sku { "skus": ["L1305", "L720"] }');
  assert(r.changed);
  assert(!r.text.includes("lookup_sku"), `got "${r.text}"`);
});

// =====================================================================
section("detectBroadNeed");
// =====================================================================

test("'going on a trip' → broad need", () => assert(detectBroadNeed("going on a trip")));
test("'wedding' → broad need", () => assert(detectBroadNeed("attending a wedding next month")));
test("'gift for my dad' → broad need", () => assert(detectBroadNeed("gift for my dad")));
test("'on my feet all day' → broad need", () => assert(detectBroadNeed("on my feet all day at work")));
test("'help me find' → broad need", () => assert(detectBroadNeed("help me find something nice")));
test("'show me red sandals' → not broad need", () => assert(!detectBroadNeed("show me red sandals")));

// =====================================================================
section("detectAiNoMatchPhrasing");
// =====================================================================

test("'we don't have' → no-match", () => assert(detectAiNoMatchPhrasing("We don't have those in stock.")));
test("'don't carry' → no-match", () => assert(detectAiNoMatchPhrasing("We don't carry that brand.")));
test("'no exact match available' → no-match", () => assert(detectAiNoMatchPhrasing("no exact match available")));
test("plain reply → no no-match", () => assert(!detectAiNoMatchPhrasing("Here are great options for you.")));
test("'Unfortunately, no…' → no-match", () => assert(detectAiNoMatchPhrasing("Unfortunately, no exact red sneakers right now.")));
test("'Sadly, no…' → no-match", () => assert(detectAiNoMatchPhrasing("Sadly, no white men's sneakers in our catalog.")));
test("'I'm afraid we don't…' → no-match", () => assert(detectAiNoMatchPhrasing("I'm afraid we don't carry that brand.")));
test("'can't find' → no-match", () => assert(detectAiNoMatchPhrasing("I can't find any in size 11.")));
test("'couldn't locate' → no-match", () => assert(detectAiNoMatchPhrasing("I couldn't locate that exact style.")));
test("'no longer carry' → no-match", () => assert(detectAiNoMatchPhrasing("We no longer carry that color.")));
test("'currently sold out' → no-match", () => assert(detectAiNoMatchPhrasing("The Vania in red is currently sold out.")));

test("stripDenialLeadIn strips leading denial sentence when pool has cards", () => {
  const before = "Unfortunately, no exact white men's sneakers right now. Here are our closest options: navy and black.";
  const r = stripDenialLeadIn(before, { poolSize: 2 });
  assert.equal(r.changed, true);
  assert.ok(!r.text.toLowerCase().startsWith("unfortunately"), `lead-in must be stripped; got: ${r.text}`);
  assert.ok(r.text.length > 20);
});

test("stripDenialLeadIn leaves text untouched when pool is empty", () => {
  const before = "Unfortunately, we don't carry that brand.";
  const r = stripDenialLeadIn(before, { poolSize: 0 });
  assert.equal(r.changed, false);
  assert.equal(r.text, before);
});

test("stripDenialLeadIn leaves text untouched when leading sentence is not a denial", () => {
  const before = "Here are some great options. Check out these styles.";
  const r = stripDenialLeadIn(before, { poolSize: 2 });
  assert.equal(r.changed, false);
});

test("stripDenialLeadIn keeps original when strip would leave <20 chars", () => {
  const before = "Unfortunately, no.";
  const r = stripDenialLeadIn(before, { poolSize: 2 });
  assert.equal(r.changed, false);
});

test("stripDenialLeadIn strips multiple leading denial sentences in a row", () => {
  const before = "We don't have that exact color. I'm afraid it's out of stock. But here are 3 close alternatives in stock.";
  const r = stripDenialLeadIn(before, { poolSize: 3 });
  assert.equal(r.changed, true);
  assert.ok(r.text.toLowerCase().startsWith("but here"), `should retain the alternatives sentence; got: ${r.text}`);
});

test("stripAvailabilityDenialSentences removes false denial lead-in but keeps correction", () => {
  const text = "We don't have any white men's sneakers in stock right now — our closest options are in Black, Grey, Navy, and Light Blue. Good news — we actually do carry white men's sneakers! Here are two styles with arch support.";
  const out = stripAvailabilityDenialSentences(text);
  assert(!out.includes("don't have"), `denial should be stripped: ${out}`);
  assert(out.includes("Good news"));
  assert(out.includes("white men's sneakers"));
});

test("stripAvailabilityDenialSentences does not wipe a single denial sentence", () => {
  const text = "We don't have any in your size.";
  assert.equal(stripAvailabilityDenialSentences(text), text);
});

// =====================================================================
section("looksLikeClarifyingQuestion");
// =====================================================================

test("ends with '?' → yes", () => assert(looksLikeClarifyingQuestion("What size do you wear?")));
test("question mid-text + last sentence → yes", () => assert(looksLikeClarifyingQuestion("Got it. So what's your arch type?")));
test("no '?' → no", () => assert(!looksLikeClarifyingQuestion("Here are some options.")));
test("empty → no", () => assert(!looksLikeClarifyingQuestion("")));

// =====================================================================
section("suggestionContradictsGender");
// =====================================================================

test("established=men + suggestion 'for women' → contradicts", () => {
  assert(suggestionContradictsGender("Do you have these for women?", "men"));
});
test("established=men + suggestion 'women's sneakers' → contradicts", () => {
  assert(suggestionContradictsGender("Show me women's sneakers", "men"));
});
test("established=women + suggestion 'for men' → contradicts", () => {
  assert(suggestionContradictsGender("Do you have these for men?", "women"));
});
test("established=men + suggestion 'in red' → no contradiction", () => {
  assert(!suggestionContradictsGender("Do you have these in red?", "men"));
});
test("established=women + suggestion 'wider widths' → no contradiction", () => {
  assert(!suggestionContradictsGender("Any wider widths?", "women"));
});
test("established=men + same gender suggestion → no contradiction", () => {
  assert(!suggestionContradictsGender("Show me more men's options", "men"));
});
test("no established gender → no contradiction", () => {
  assert(!suggestionContradictsGender("Do you have these for women?", null));
});
test("established=kids → no contradiction (kids isn't binary)", () => {
  assert(!suggestionContradictsGender("Show me men's", "kids"));
});
test("empty suggestion → no contradiction", () => {
  assert(!suggestionContradictsGender("", "men"));
});

// =====================================================================
section("detectFootwearOverElicitation");
// =====================================================================

const FAKE_TYPES = ["Sneakers", "Sandals", "Boots", "Loafers", "Mary Janes", "Wedges Heels"];

test("footwear=true + gender=Men + 'Sneakers' chip → fires", () => {
  const r = detectFootwearOverElicitation({
    classifiedIntent: { isFootwearRequest: true, attributes: { gender: "Men" } },
    latestUserMessage: "Sneakers",
    establishedGender: "men",
    catalogProductTypes: FAKE_TYPES,
  });
  assert(r, "expected guard to fire");
  assert.equal(r.gender, "men");
  assert.equal(r.category, "sneakers");
  assert(r.directive.includes("search_products"));
  assert(r.directive.includes("THIS TURN"));
});

test("footwear=true + gender=Women + 'Sandals' chip → fires", () => {
  const r = detectFootwearOverElicitation({
    classifiedIntent: { isFootwearRequest: true, attributes: {} },
    latestUserMessage: "Sandals",
    establishedGender: "women",
    catalogProductTypes: FAKE_TYPES,
  });
  assert(r);
  assert.equal(r.category, "sandals");
});

test("footwear=true + gender=Men + 'Mary Janes' chip → fires", () => {
  const r = detectFootwearOverElicitation({
    classifiedIntent: { isFootwearRequest: true, attributes: {} },
    latestUserMessage: "Mary Janes",
    establishedGender: "men",
    catalogProductTypes: FAKE_TYPES,
  });
  assert(r);
});

test("footwear=false → does not fire", () => {
  const r = detectFootwearOverElicitation({
    classifiedIntent: { isFootwearRequest: false, attributes: {} },
    latestUserMessage: "Sneakers",
    establishedGender: "men",
    catalogProductTypes: FAKE_TYPES,
  });
  assert.equal(r, null);
});

test("no established gender → does not fire", () => {
  const r = detectFootwearOverElicitation({
    classifiedIntent: { isFootwearRequest: true, attributes: {} },
    latestUserMessage: "Sneakers",
    establishedGender: null,
    catalogProductTypes: FAKE_TYPES,
  });
  assert.equal(r, null);
});

test("latest message is not a category → does not fire", () => {
  const r = detectFootwearOverElicitation({
    classifiedIntent: { isFootwearRequest: true, attributes: {} },
    latestUserMessage: "what about something cheaper",
    establishedGender: "men",
    catalogProductTypes: FAKE_TYPES,
  });
  assert.equal(r, null);
});

test("category not in catalog → does not fire", () => {
  const r = detectFootwearOverElicitation({
    classifiedIntent: { isFootwearRequest: true, attributes: {} },
    latestUserMessage: "Galoshes",
    establishedGender: "men",
    catalogProductTypes: FAKE_TYPES,
  });
  assert.equal(r, null);
});

test("no classifier → does not fire", () => {
  const r = detectFootwearOverElicitation({
    classifiedIntent: null,
    latestUserMessage: "Sneakers",
    establishedGender: "men",
    catalogProductTypes: FAKE_TYPES,
  });
  assert.equal(r, null);
});

test("free-text 'how about shoes for my dad' → fires with Footwear", () => {
  // Production trace: customer says "how about shoes for my dad, he
  // is 90 years old..." — gender=Men + classifier footwear=true.
  // Without this path the over-elicitation guard didn't fire and the
  // LLM asked a clarifying question instead of searching.
  const r = detectFootwearOverElicitation({
    classifiedIntent: { isFootwearRequest: true, attributes: { gender: "Men" } },
    latestUserMessage: "how about shoes for my dad, he is 90 years old",
    establishedGender: "men",
    catalogProductTypes: FAKE_TYPES,
  });
  assert(r, "guard should fire on 'shoes for my dad' free-text");
  assert.equal(r.gender, "men");
  assert.equal(r.category, "footwear");
});

test("free-text 'I need sandals for my mom' → fires with Sandals (specific match)", () => {
  const r = detectFootwearOverElicitation({
    classifiedIntent: { isFootwearRequest: true, attributes: {} },
    latestUserMessage: "I need sandals for my mom",
    establishedGender: "women",
    catalogProductTypes: FAKE_TYPES,
  });
  assert(r);
  assert.equal(r.category, "sandals");
});

test("free-text 'looking for some boots in size 10' → fires with Boots", () => {
  const r = detectFootwearOverElicitation({
    classifiedIntent: { isFootwearRequest: true, attributes: {} },
    latestUserMessage: "looking for some boots in size 10",
    establishedGender: "women",
    catalogProductTypes: FAKE_TYPES,
  });
  assert(r);
  assert.equal(r.category, "boots");
});

test("free-text 'do you have anything good?' → does NOT fire (no category)", () => {
  const r = detectFootwearOverElicitation({
    classifiedIntent: { isFootwearRequest: true, attributes: {} },
    latestUserMessage: "do you have anything good?",
    establishedGender: "men",
    catalogProductTypes: FAKE_TYPES,
  });
  assert.equal(r, null);
});

// =====================================================================
// Internal-language leak scrub (M1 stabilization)
// =====================================================================
//
// Production trace: the LLM occasionally leaks resolver-state lingo
// into customer-facing text ("The resolver state indicates...").
// Customer must never see internal terminology. The scrub strips
// lead-in phrases when it can; if a forbidden term still remains,
// the whole reply is replaced with a neutral clarification line.

test("internal-leak — strips 'The resolver state indicates...' lead-in", () => {
  const before = "The resolver state indicates there are currently no men's orthotics matching in the catalog right now.";
  const r = stripInternalLeaks(before);
  assert.equal(r.changed, true, "must mark changed");
  assert.equal(r.replaced, false, "lead-in strip should NOT fall back to full replacement");
  assert.equal(containsInternalLanguageLeak(r.text), false, `output must be free of internal terms: ${r.text}`);
  assert.ok(/no men's orthotics/i.test(r.text), `meaningful tail must survive: ${r.text}`);
  assert.ok(/^[A-Z]/.test(r.text), `first letter must be capitalized: ${r.text}`);
});

test("internal-leak — strips 'Based on the resolver state, ...' lead-in", () => {
  const before = "Based on the resolver state, I don't see a pink men's sneaker in our catalog.";
  const r = stripInternalLeaks(before);
  assert.equal(r.changed, true);
  assert.equal(containsInternalLanguageLeak(r.text), false);
});

test("internal-leak — bare 'matched_constraints shows X' lead-in stripped", () => {
  const before = "matched_constraints shows there's no red sandal in men's right now.";
  const r = stripInternalLeaks(before);
  assert.equal(r.changed, true);
  assert.equal(containsInternalLanguageLeak(r.text), false);
});

test("internal-leak — falls back to neutral line when forbidden term remains", () => {
  // No matching lead-in pattern, but the forbidden term is still
  // present somewhere in the body — whole-reply fallback fires.
  const before = "Quick note about the recommended_next_action: we suggest you look at sneakers.";
  const r = stripInternalLeaks(before);
  assert.equal(r.changed, true);
  assert.equal(r.replaced, true, "must fall back to neutral line");
  assert.equal(containsInternalLanguageLeak(r.text), false);
});

test("internal-leak — falls back when 'I'll run a live search because the resolver said' appears", () => {
  const before = "I'll run a live search because the resolver said no products match.";
  const r = stripInternalLeaks(before);
  assert.equal(r.changed, true);
  assert.equal(containsInternalLanguageLeak(r.text), false);
});

test("internal-leak — leaves clean customer text untouched", () => {
  const before = "Here are some great women's sandals with arch support — built for plantar fasciitis.";
  const r = stripInternalLeaks(before);
  assert.equal(r.changed, false, `must not modify clean text; got: ${r.text}`);
  assert.equal(r.replaced, false);
});

test("internal-leak — does NOT match the word 'system' when not in 'system prompt'", () => {
  // Common shoe-industry term ("arch support system") must not trip
  // the FORBIDDEN_INTERNAL_TERMS_RE.
  const before = "Our memory foam system keeps the arch supported all day.";
  const r = stripInternalLeaks(before);
  assert.equal(r.replaced, false, `must not fall back on benign 'system'; got: ${r.text}`);
});

test("internal-leak — containsInternalLanguageLeak detector catches every banned term", () => {
  const phrases = [
    "Looking at resolver state, we don't carry that.",
    "matched_constraints says no.",
    "inferred_constraints suggests women's.",
    "impossible_constraints includes color.",
    "recommended_next_action is to ask gender.",
    "candidate_products is empty.",
    "do_not_ask includes gender.",
    "system prompt told me to skip this.",
    "Per the tool call I ran...",
  ];
  for (const p of phrases) {
    assert.equal(containsInternalLanguageLeak(p), true, `must flag: "${p}"`);
  }
});

test("internal-leak — full-pipeline ordering: scrub runs before banned-narration", () => {
  // Verifies the customer-facing TEXT shape we promise the user:
  // after the leak scrub, no internal terms appear. Mirrors the
  // chat.jsx call site by composing both steps in this order.
  const incoming = "The resolver state indicates there are no men's pink sandals. Let me look that up for you.";
  const afterLeak = stripInternalLeaks(incoming).text;
  assert.equal(containsInternalLanguageLeak(afterLeak), false);
});

// =====================================================================
// Orthotic internal-enum scrub (R5)
// =====================================================================

test("enum-scrub — known condition tokens become friendly labels", () => {
  const r = scrubInternalEnums("Given your overpronation_flat_feet, this insole helps.");
  assert.equal(r.changed, true);
  assert.ok(/flat feet or overpronation/i.test(r.text), `got: ${r.text}`);
  assert.ok(!/overpronation_flat_feet/.test(r.text), `raw enum must not survive: ${r.text}`);
});

test("enum-scrub — useCase and arch tokens become friendly labels", () => {
  const r = scrubInternalEnums("Picked for comfort_walking_everyday and your high_arch feet.");
  assert.ok(/everyday walking/i.test(r.text), `got: ${r.text}`);
  assert.ok(/high arches/i.test(r.text), `got: ${r.text}`);
  assert.ok(!/comfort_walking_everyday|high_arch/.test(r.text), `raw enums must not survive: ${r.text}`);
});

test("enum-scrub — node ids (q_arch / q_use_case) are removed entirely", () => {
  const r = scrubInternalEnums("Next we ask q_arch then q_use_case to narrow it down.");
  assert.ok(!/q_arch|q_use_case/.test(r.text), `node ids must not survive: ${r.text}`);
});

test("enum-scrub — unmapped enum-shaped token is humanized, never raw", () => {
  assert.equal(friendlyEnumLabel("some_internal_token"), "some internal token");
  const r = scrubInternalEnums("matched some_internal_token here");
  assert.ok(!/some_internal_token/.test(r.text), `raw token must not survive: ${r.text}`);
});

test("enum-scrub — clean customer text is left untouched", () => {
  const clean = "Here are some women's sandals with arch support for plantar fasciitis.";
  const r = scrubInternalEnums(clean);
  assert.equal(r.changed, false, `must not modify clean text; got: ${r.text}`);
});

test("enum-scrub — every known enum token resolves to an enum-free label", () => {
  const tokens = [
    "low_arch","high_arch","medium_arch","plantar_fasciitis","heel_spurs",
    "metatarsalgia","mortons_neuroma","overpronation_flat_feet","comfort_walking_everyday",
    "comfort_memory_foam","comfort_memory_foam_everyday","athletic_running",
    "athletic_training_gym","athletic_training_sports","dress_no_removable","dress_premium",
    "boots_construction","winter_boots","work_all_day","non_removable","comfort_bundle",
  ];
  for (const t of tokens) {
    const label = friendlyEnumLabel(t);
    assert.ok(!/_/.test(label), `label for ${t} still contains underscore: "${label}"`);
    const r = scrubInternalEnums(`recommendation note: ${t}.`);
    assert.ok(!new RegExp(t).test(r.text), `raw token ${t} survived scrub: ${r.text}`);
  }
});

// =====================================================================
// Suggested-follow-up answerability gate
// =====================================================================

test("suggestion-gate — drops unverifiable discount mechanics (GovX by category)", () => {
  const v = isUnanswerableSuggestion("Does GovX apply to specific product categories?", { lastText: "Here are men's sneakers." });
  assert.equal(v.unanswerable, true, `should drop; got ${JSON.stringify(v)}`);
});

test("suggestion-gate — drops spec deep-dive when subject not in reply", () => {
  const v = isUnanswerableSuggestion("Tell me more about the UltraSKY technology", { lastText: "Here are men's sneakers." });
  assert.equal(v.unanswerable, true);
});

test("suggestion-gate — allows spec deep-dive when subject WAS mentioned", () => {
  const v = isUnanswerableSuggestion("Tell me more about the arch support", { lastText: "These have built-in arch support." });
  assert.equal(v.unanswerable, false, `should allow; got ${JSON.stringify(v)}`);
});

test("suggestion-gate — drops branded tech name absent from reply", () => {
  const v = isUnanswerableSuggestion("How does OrthoLite compare?", { lastText: "Here are women's sandals." });
  assert.equal(v.unanswerable, true);
});

test("suggestion-gate — drops spec/measurement not quoted in reply", () => {
  const v = isUnanswerableSuggestion("What's the heel height?", { lastText: "Here are women's wedges." });
  assert.equal(v.unanswerable, true);
});

test("suggestion-gate — keeps good pivots (gender / width / price)", () => {
  for (const q of ["Do you have these in women's?", "Do you have wider widths?", "Anything under $100?", "Show me sneakers instead"]) {
    const v = isUnanswerableSuggestion(q, { lastText: "Here are men's sandals." });
    assert.equal(v.unanswerable, false, `must keep "${q}"; got ${JSON.stringify(v)}`);
  }
});

// =====================================================================
// Resolver fulfillment invariant (M1 stabilization)
// =====================================================================
//
// If resolverState.recommended_next_action.type === "recommend"
// AND candidate_products.length > 0, the customer MUST see cards.
// Empty-pool repair and the "nothing's quite hitting" fallback are
// both gated on !resolverPromisedRecommendation(ctx.resolverState).

test("fulfillment — predicate true when action=recommend with candidates", () => {
  const state = {
    type: "resolver_state",
    matched_constraints: { category: "orthotics", gender: "women" },
    inferred_constraints: {},
    impossible_constraints: [],
    recommended_next_action: { type: "recommend", reason: "match" },
    candidate_products: [
      { handle: "l620w", title: "L620W", availability: "in_stock" },
      { handle: "l800w", title: "L800W", availability: "in_stock" },
    ],
  };
  assert.equal(resolverPromisedRecommendation(state), true);
});

test("fulfillment — predicate false when action=ask (even with candidates)", () => {
  assert.equal(
    resolverPromisedRecommendation({
      type: "resolver_state",
      recommended_next_action: { type: "ask", field: "category" },
      candidate_products: [{ handle: "x", title: "X", availability: "in_stock" }],
      matched_constraints: {}, inferred_constraints: {}, impossible_constraints: [],
    }),
    false,
    "ask must not trigger the recommend invariant",
  );
});

test("fulfillment — predicate false when action=recommend but candidates empty", () => {
  assert.equal(
    resolverPromisedRecommendation({
      type: "resolver_state",
      recommended_next_action: { type: "recommend", reason: "?" },
      candidate_products: [],
      matched_constraints: {}, inferred_constraints: {}, impossible_constraints: [],
    }),
    false,
    "recommend with zero candidates must NOT promise — nothing to render",
  );
});

test("fulfillment — predicate false for no_match / controlled_oos / skip", () => {
  for (const action of ["no_match", "controlled_oos", "skip"]) {
    assert.equal(
      resolverPromisedRecommendation({
        type: "resolver_state",
        recommended_next_action: { type: action, reason: "x" },
        candidate_products: [{ handle: "x", title: "X", availability: "in_stock" }],
        matched_constraints: {}, inferred_constraints: {}, impossible_constraints: [],
      }),
      false,
      `${action} must not trigger the recommend invariant`,
    );
  }
});

test("fulfillment — predicate false for null / undefined / skip-shape resolverState", () => {
  assert.equal(resolverPromisedRecommendation(null), false);
  assert.equal(resolverPromisedRecommendation(undefined), false);
  assert.equal(resolverPromisedRecommendation({ type: "skip", reason: "facet_index_not_built" }), false);
});

test("fulfillment — empty-pool repair guard: skips when resolver promised recommend", () => {
  // Mirrors the chat.jsx empty-pool repair condition. The composite
  // predicate must evaluate to FALSE (do-not-strip) when resolver
  // promised a recommendation.
  const ctx = {
    resolverState: {
      type: "resolver_state",
      recommended_next_action: { type: "recommend" },
      candidate_products: [{ handle: "l620w", title: "L620W", availability: "in_stock" }],
      matched_constraints: { category: "orthotics", gender: "women" },
      inferred_constraints: {}, impossible_constraints: [],
    },
  };
  const shouldStripEmptyPool =
    /* pool.length === 0 */ true &&
    /* looksLikeProductPitch */ true &&
    /* !looksLikeClarifyingQuestion */ true &&
    /* !recommenderAskedForMoreInfo */ true &&
    /* !isBrandOrInfoQuestion */ true &&
    !resolverPromisedRecommendation(ctx.resolverState);
  assert.equal(shouldStripEmptyPool, false, "empty-pool repair MUST stand down when resolver promised recommend");
});

test("fulfillment — fallback selector: never emits 'nothing's quite hitting' when resolver promised recommend", () => {
  // Mirrors the chat.jsx fallback selection. With promised recommend
  // the soft clarification line is used; otherwise the legacy line.
  const selectFallback = (resolverState) =>
    resolverPromisedRecommendation(resolverState)
      ? "Tell me a bit more about what you need — condition, use-case, anything — and I'll narrow it down."
      : "Hmm, nothing's quite hitting that combination — want to widen the budget, try a different color, or look at another style?";

  const promised = {
    type: "resolver_state",
    recommended_next_action: { type: "recommend" },
    candidate_products: [{ handle: "l620w", title: "L620W", availability: "in_stock" }],
    matched_constraints: { category: "orthotics", gender: "women" },
    inferred_constraints: {}, impossible_constraints: [],
  };
  const noPromise = null;

  const promisedFallback = selectFallback(promised);
  assert.ok(
    !/nothing.{0,3}s quite hitting/i.test(promisedFallback) &&
      !/no match/i.test(promisedFallback) &&
      !/can.{0,2}t find/i.test(promisedFallback) &&
      !/combination/i.test(promisedFallback),
    `fallback for promised recommend must not contain forbidden no-match phrases: ${promisedFallback}`,
  );
  assert.ok(/nothing.{0,3}s quite hitting/i.test(selectFallback(noPromise)), "legacy fallback still fires when no resolver promise");
});

// =====================================================================
console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  • ${f.name}`);
    console.log(`    ${f.err?.message || f.err}`);
  }
  process.exit(1);
}
