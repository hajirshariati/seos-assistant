// Lean engine — what one assistant reply costs, from this store's real data.
//
// Measures the actual instructions + tool definitions Claude receives for this
// store and the actual size of its search results, then prices a typical
// reply the way the engine runs it (search → show → answer; store questions:
// look up → answer) with prompt caching as the engine uses it. Pure.

import { buildLeanTools } from "./tools.js";
import { buildLeanSystemPrompt } from "./prompt.js";
import { leanSearch } from "./search.js";

// Claude's tokenizer averages about 3.5 characters per token on this mix of
// English and JSON. Exact counts come from recorded usage once replies run.
const CHARS_PER_TOKEN = 3.5;
export const tokensOf = (value) =>
  Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / CHARS_PER_TOKEN);

// Assumptions, shown to the merchant next to the estimate.
export const COST_ASSUMPTIONS = {
  productShare: 0.7,          // replies that search products; the rest answer store questions
  rewriteRate: 0.1,           // replies the fact check sends back for one rewrite
  historyTokensPerTurn: 180,  // earlier messages in the chat, per previous reply
  avgPriorTurns: 1.5,         // a typical reply has ~1.5 earlier replies before it
  storeInfoTokens: 700,       // store-page excerpts returned for a policy question
  outputTokens: { toolCall: 70, show: 60, answer: 140 },
};

// pricing: $ per 1M tokens { input, output, cacheRead, cacheWrite }.
function price(p, { read = 0, write = 0, input = 0, output = 0 }) {
  return (read * p.cacheRead + write * p.cacheWrite + input * p.input + output * p.output) / 1_000_000;
}

// One reply = a chain of calls. `steps` are the new tokens each call adds
// after its predecessor (tool results), and the output it writes.
function chainCost(p, { prefix, firstTail, steps }) {
  let cost = 0;
  let cached = 0;   // conversation tokens already in cache from the previous call
  let tail = firstTail;
  for (const s of steps) {
    // prefix (tools + instructions) is read from cache; the conversation up to
    // the previous call is read from cache; the new tail is written to cache.
    cost += price(p, { read: prefix + cached, write: tail, output: s.output });
    cached += tail;
    tail = s.output + (s.addsTokens || 0); // Claude's call + the tool's result, cached on the next call
  }
  return cost;
}

export function measureStore({ catalog, config = {}, shop = "", extraSystemText = "", storeTools = [] }) {
  const vocab = catalog?.vocab || {};
  const tools = [...buildLeanTools(vocab, { similar: true }), ...storeTools];
  const system = buildLeanSystemPrompt({ config, vocab, shop });
  // Typical searches: the store's biggest categories, unfiltered otherwise.
  const cats = (vocab.categories || []).slice(0, 3).map((c) => c.value);
  const samples = (cats.length ? cats : [""]).map((c) => leanSearch(catalog, { query: "comfortable", ...(c ? { categories: [c] } : {}) }));
  const searchTokens = Math.round(samples.reduce((n, r) => n + tokensOf(r), 0) / samples.length);
  return {
    prefixTokens: tokensOf(tools) + tokensOf(system),
    extraTokens: tokensOf(extraSystemText || ""),
    searchTokens,
    products: catalog?.products?.length || 0,
  };
}

export function replyCost(pricing, measured, a = COST_ASSUMPTIONS) {
  const prefix = measured.prefixTokens;
  const history = Math.round(a.historyTokensPerTurn * a.avgPriorTurns);
  const firstTail = measured.extraTokens + history + 40; // + the new customer message
  const o = a.outputTokens;
  const product = chainCost(pricing, {
    prefix,
    firstTail,
    steps: [
      { output: o.toolCall, addsTokens: measured.searchTokens },
      { output: o.show, addsTokens: 60 },
      { output: o.answer },
    ],
  });
  const info = chainCost(pricing, {
    prefix,
    firstTail,
    steps: [
      { output: o.toolCall, addsTokens: a.storeInfoTokens },
      { output: o.answer },
    ],
  });
  // A rewrite is one more answer call with everything before it cached.
  const rewrite = price(pricing, { read: prefix + firstTail + measured.searchTokens + 400, write: 80, output: o.answer });
  const perReply = a.productShare * product + (1 - a.productShare) * info + a.rewriteRate * rewrite;
  return { perReply, product, info, rewrite };
}

// When replies are minutes apart the cached instructions expire (5 minutes)
// and the next reply writes them again. Extra cost of such a "cold" reply:
export function coldStartExtra(p, measured) {
  return (measured.prefixTokens * (p.cacheWrite - p.cacheRead)) / 1_000_000;
}
