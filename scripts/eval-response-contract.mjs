import assert from "node:assert/strict";
import {
  filterProductCardsToCatalogScope,
  ensureCompleteCustomerText,
  productPoolSatisfiesCatalogScope,
  reconcileProseToCards,
  repairProductTurnAssembly,
  repairProductResponseText,
  stripMissingSkus,
} from "../app/lib/response-contract.server.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

console.log("Response contract eval\n");

const whiteMensSneakerPool = [
  {
    title: "Dash Arch Support Men's Sneaker - White",
    productType: "Walking Shoes",
    _gender: "Men",
    _category: "Sneakers",
    _attributes: { Color: "White", Gender: "Men", Category: "Sneakers" },
  },
];

const ctx = {
  sessionMemory: { explicit: { gender: "men", category: "sneakers", color: "white" } },
  classifiedIntent: { attributes: {} },
  resolverState: { type: "resolver_state", matched_constraints: {}, inferred_constraints: {} },
};

test("R1 — exact-scope card pool satisfies current scope", () => {
  assert.equal(productPoolSatisfiesCatalogScope(whiteMensSneakerPool, ctx.sessionMemory.explicit), true);
});

test("R2 — contradictory denial is stripped when exact products are present", () => {
  const text = "We don't have any white men's sneakers in stock right now. Good news — we actually do carry white men's sneakers! Here are two styles.";
  const out = repairProductResponseText({ text, pool: whiteMensSneakerPool, ctx });
  assert.equal(out.changed, true);
  assert.equal(/don't have|in stock right now/i.test(out.text), false);
  assert.match(out.text, /actually do carry|matching styles/i);
  assert.equal(out.contract.status, "exact_match");
});

test("R3 — unrelated product pool does not erase a true denial", () => {
  const text = "We don't have white men's sneakers in stock right now.";
  const out = repairProductResponseText({
    text,
    pool: [{ title: "Black Sandal", _gender: "Women", _category: "Sandals", _attributes: { Color: "Black" } }],
    ctx,
  });
  assert.equal(out.changed, false);
  assert.equal(out.text, text);
});

test("R4 — product turn strips clarifying chips instead of showing ask+answer", () => {
  const text = "What type of men's footwear are you looking for? Here are our men's black sandals — two good options. <<Sandals>><<Sneakers>><<Clogs>><<Accessories>>";
  const pool = [
    {
      title: "Maui Men's Sandal - Black",
      _gender: "men",
      _category: "sandals",
      _attributes: { Color: "Black", Gender: "Men", Category: "Sandals" },
    },
  ];
  const out = repairProductTurnAssembly({ text, pool });
  assert.equal(out.changed, true);
  assert.equal(/<</.test(out.text), false);
  assert.equal(/^what type/i.test(out.text), false);
  assert.match(out.text, /men's black sandals/i);
});

test("R5 — scoped card filter drops off-category semantic cards", () => {
  const mixedPool = [
    {
      title: "Danika Arch Support Sneaker - Pink",
      _gender: "women",
      _category: "sneakers",
      _attributes: { Color: "Pink", Gender: "Women", Category: "Sneakers" },
    },
    {
      title: "Vicki Braided Thong Sandal - Light Pink",
      _gender: "women",
      _category: "sandals",
      _attributes: { Color: "Pink", Gender: "Women", Category: "Sandals" },
    },
  ];
  const scoped = filterProductCardsToCatalogScope(mixedPool, {
    sessionMemory: { explicit: { gender: "women", category: "sandals", color: "pink" } },
  });
  assert.equal(scoped.products.length, 1);
  assert.equal(scoped.products[0].title, "Vicki Braided Thong Sandal - Light Pink");
  assert.equal(scoped.dropped, 1);
  assert.equal(scoped.enforcedColor, true);
});

test("R6 — scoped card filter keeps same-category alternatives when exact color is unavailable", () => {
  const alternatives = [
    {
      title: "Kendall Sandal - Burgundy",
      _gender: "women",
      _category: "sandals",
      _attributes: { Color: "Burgundy", Gender: "Women", Category: "Sandals" },
    },
    {
      title: "Vania Sandal - Wine",
      _gender: "women",
      _category: "sandals",
      _attributes: { Color: "Wine", Gender: "Women", Category: "Sandals" },
    },
  ];
  const scoped = filterProductCardsToCatalogScope(alternatives, {
    sessionMemory: { explicit: { gender: "women", category: "sandals", color: "red" } },
  });
  assert.equal(scoped.products.length, 2);
  assert.equal(scoped.dropped, 0);
  assert.equal(scoped.enforcedColor, false);
});

test("R7 — prose reconciliation corrects card-count claims", () => {
  const cards = [
    { title: "Danika Arch Support Sneaker - Pink", _attributes: { Color: "Pink" } },
    { title: "Kinsley Arch Support Sneaker - Pink", _attributes: { Color: "Pink" } },
    { title: "Xspress Runner 2 Sneaker - Pink", _attributes: { Color: "Pink" } },
  ];
  const out = reconcileProseToCards({
    text: "Here are four pink women's sneakers to choose from.",
    cards,
    ctx: { sessionMemory: { explicit: { gender: "women", category: "sneakers", color: "pink" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /three pink women's sneakers/i);
});

test("R8 — prose reconciliation does not call an actual purple card closest-to-purple", () => {
  const out = reconcileProseToCards({
    text: "The Dani Arch Support Sneaker - Eggplant is the closest match to purple.",
    cards: [{ title: "Dani Arch Support Sneaker - Eggplant", _attributes: { Color: "Eggplant" } }],
    ctx: { sessionMemory: { explicit: { gender: "women", category: "sneakers", color: "purple" } } },
  });
  assert.equal(out.changed, true);
  assert.equal(/closest match to purple/i.test(out.text), false);
  assert.match(out.text, /purple option/i);
});

test("R9 — prose reconciliation removes ungrounded universal feature claims", () => {
  const out = reconcileProseToCards({
    text: "Here are two pink sandals. They all have waterproof protection.",
    cards: [
      { title: "Vicki Braided Thong Sandal - Pink", _attributes: { Color: "Pink" } },
      { title: "Jillian Sport Sandal - Blush", _attributes: { Color: "Pink" } },
    ],
    ctx: { sessionMemory: { explicit: { gender: "women", category: "sandals", color: "pink" } } },
  });
  assert.equal(out.changed, true);
  assert.equal(/waterproof/i.test(out.text), false);
});

test("R10 — coherence guard trims dangling strip-chain fragments", () => {
  const out = ensureCompleteCustomerText({
    text: "Good news — across these sneakers, the widest option available is medium width. None of these styles offer a dedicated wide width option, so the width options are.",
  });
  assert.equal(out.changed, true);
  assert.equal(/width options are\.$/i.test(out.text), false);
  assert.match(out.text, /medium width\./i);
});

test("R11 — feature repair preserves the scoped product intro", () => {
  const out = reconcileProseToCards({
    text: "Here are women's black sandals with waterproof protection and arch support.",
    cards: [
      { title: "Jess Adjustable Quarter Strap Sandal - Black Sparkle", _attributes: { Color: "Black", Category: "Sandals", Gender: "Women" } },
      { title: "Charli Thong Sandal - Black", _attributes: { Color: "Black", Category: "Sandals", Gender: "Women" } },
    ],
    ctx: { sessionMemory: { explicit: { gender: "women", category: "sandals", color: "black" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /women's black sandals/i);
  assert.equal(/waterproof|arch support/i.test(out.text), false);
});

test("R12 — feature repair does not clip hyphenated color phrasing", () => {
  const out = reconcileProseToCards({
    text: "Here are some pink and warm-toned women's sandals with arch support.",
    cards: [
      { title: "Vicki Braided Thong Sandal - Light Pink Gloss", _attributes: { Color: "Pink", Category: "Sandals", Gender: "Women" } },
      { title: "Jillian Sport Sandal - Shimmer Blush", _attributes: { Color: "Pink", Category: "Sandals", Gender: "Women" } },
    ],
    ctx: { sessionMemory: { explicit: { gender: "women", category: "sandals", color: "pink" } } },
  });
  assert.equal(out.changed, true);
  assert.match(out.text, /warm-toned women's sandals/i);
  assert.equal(/arch support/i.test(out.text), false);
});

test("R13 — missing SKU strip repairs orphaned article", () => {
  const out = stripMissingSkus("I don't see an L9999 in our catalog.", ["L9999"]);
  assert.equal(out, "I don't see that in our catalog.");
});

if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`- ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}

console.log(`\nResponse contract eval: ${passed}/${passed + failed} passed`);
