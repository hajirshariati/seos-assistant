// Prices one assistant reply for this store from its real catalog,
// instructions and enabled tools (see cost-model.js).
import { chatModel } from "../claude-models.js";
import { loadLeanCatalog } from "./catalog.server.js";
import { buildLeanStoreExtras } from "./store-tools.server.js";
import { measureStore, replyCost, coldStartExtra } from "./cost-model.js";
import { MODEL_PRICING } from "../pricing.server.js";

export async function estimateStoreReplyCost(shop, config = {}) {
  const model = chatModel(config.anthropicModel);
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["claude-sonnet-4-6"];
  const [catalog, extras] = await Promise.all([
    loadLeanCatalog(shop),
    buildLeanStoreExtras({ shop, config, messages: [], log: () => {} })
      .catch(() => ({ tools: [], systemBlock: "" })),
  ]);
  const measured = measureStore({
    catalog,
    config,
    shop,
    extraSystemText: extras.systemBlock,
    storeTools: extras.tools.map((t) => t.definition),
  });
  const cost = replyCost(pricing, measured);
  return { model, ...measured, ...cost, coldStartExtra: coldStartExtra(pricing, measured) };
}
