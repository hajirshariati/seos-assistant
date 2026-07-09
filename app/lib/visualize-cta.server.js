// "Visualize My Look" CTA payload builder (pure, no heavy deps so the
// recommender gate can import it without pulling in Prisma).
//
// Emitted as an SSE `visualize_cta` event ONLY when the turn ends with
// exactly ONE recommended product AND the feature is fully configured.
// The widget renders it as a distinct, attention-grabbing FIRST chip;
// on click it POSTs { productHandle, styleContext } to /visualize.

import { isImageProviderSupported } from "./image-styling.server.js";
import { classifyCatalogItemType } from "./turn-plan.server.js";

// Scene presets per footwear category, shown in the style-preview panel so the
// shopper can re-render the SAME shoe in real-life settings. `label` is what the
// shopper sees; `ctx` is the scene phrase fed to /visualize as styleContext.
// Pure data + a pure classifier → unit-testable.
export const VISUALIZE_SCENE_GROUPS = {
  sandals: [
    { label: "Vacation", ctx: "a sunny vacation beach boardwalk by the ocean" },
    { label: "Weekend", ctx: "a relaxed weekend outdoor setting" },
    { label: "Dinner", ctx: "an elegant evening dinner venue" },
    { label: "Workday", ctx: "a polished everyday workday setting" },
  ],
  sneakers: [
    { label: "Walking", ctx: "a scenic outdoor walking path" },
    { label: "Travel", ctx: "a stylish city street while traveling" },
    { label: "Errands", ctx: "a bright casual everyday errands setting" },
    { label: "Workday", ctx: "a polished everyday workday setting" },
  ],
  dress: [
    { label: "Office", ctx: "a modern professional office setting" },
    { label: "Dinner", ctx: "an elegant evening dinner venue" },
    { label: "Travel", ctx: "a stylish city street while traveling" },
    { label: "Weekend", ctx: "a refined weekend outing" },
  ],
};

// Pick the scene group from a product's category/title. Sandals & wedges →
// sandals; sneakers/athletic → sneakers; loafers/dress/boots/heels → dress.
// Unknown footwear falls back to the (most general) sneakers set.
export function visualizeSceneGroup(category = "", title = "") {
  const hay = `${category} ${title}`.toLowerCase();
  if (/\b(?:sandals?|wedges?|slides?|flip[\s-]*flops?|espadrilles?)\b/.test(hay)) return "sandals";
  if (/\b(?:sneakers?|trainers?|athletic|running|runners?|tennis)\b/.test(hay)) return "sneakers";
  if (/\b(?:loafers?|oxfords?|dress|boots?|booties?|bootie|heels?|pumps?|mary[\s-]*janes?|flats?|clogs?|mules?|slippers?)\b/.test(hay)) return "dress";
  return "sneakers";
}

function recentUserStyleContext(messages, max = 4) {
  if (!Array.isArray(messages)) return "";
  const users = messages
    .filter((m) => m && m.role === "user" && typeof m.content === "string" && m.content.trim())
    .map((m) => m.content.trim());
  return users.slice(-max).join(" — ").slice(0, 500);
}

// Returns the SSE event object or null. `config` must carry the
// (decrypted) provider keys, as getShopConfig provides.
export function buildVisualizeCtaEvent({ config, product, messages, isInsoleRecommendation = false }) {
  if (!config?.visualizeLookEnabled) return null;
  // STRUCTURAL GUARANTEE: the orthotic recommender (recommend_orthotic) ONLY ever
  // returns insoles/orthotics — products that go INSIDE a shoe, never worn on
  // their own. So a turn driven by it is never visualize-eligible, regardless of
  // how the SKU is category-tagged. This is the reliable signal; the
  // category/title checks below are defense-in-depth for the non-recommender
  // paths (named-product / search) where an insole can still surface.
  if (isInsoleRecommendation) return null;
  const provider = String(config.imageProvider || "").trim();
  if (!isImageProviderSupported(provider)) return null;
  // Don't dangle a button that will error on click — require the key
  // for the selected provider.
  const hasKey = provider === "gemini" ? Boolean(config.geminiApiKey) : Boolean(config.openaiApiKey);
  if (!hasKey) return null;

  const handle = String(product?.handle || "").trim();
  const image = product?.image || product?.featuredImageUrl || "";
  if (!handle || !image) return null; // need a product with an image to style

  // "Visualize My Look" is an AI styling preview of the product being
  // WORN — it only makes sense for wearable footwear you can see on a
  // person. Never offer it for accessories, shoe-care, socks, gift cards,
  // or $0 service line items (prod trace 2026-06-23: a "VIP Processing"
  // $0.00 SKU got the CTA on an order-status turn).
  const NON_WEARABLE_RE =
    /\b(?:accessor|shoe[\s-]*care|care[\s-]*kit|cleaner|cleaning|protect|spray|sock|gift[\s-]*card|lace|freshener|deodor|roller|\bkit\b|processing|shipping|handling|surcharge|warranty|\bfee\b|deposit)/i;
  const category = String(product?.category || product?._category || product?.productType || "");
  const title = String(product?.title || "");
  if (NON_WEARABLE_RE.test(category) || NON_WEARABLE_RE.test(title)) return null;

  // EXCLUDE true orthotic INSOLES: they sit INSIDE a shoe, so "see it on"
  // produces a nonsensical insole-on-a-bare-foot image (prod traces 2026-06-24
  // "Men's Premium Memory Foam Orthotics", 2026-06-29 "Men's Speed Orthotics -
  // Insole For Running", 2026-06-30 "Men's Orthotics for Overpronation"). The
  // CENTRAL classifier decides — the same one commerce truth uses — so a real
  // wearable sandal with "Orthotic" in its name ("Maui Orthotic Flips") stays
  // eligible, while insole/insert/footbed titles and bare-"Orthotics" products
  // are blocked, however the SKU is category-tagged.
  if (classifyCatalogItemType(product) === "orthotic_insole") return null;
  const priceNum = Number(product?.price);
  if (Number.isFinite(priceNum) && priceNum <= 0) return null;

  const sceneGroup = visualizeSceneGroup(category, title);
  return {
    type: "visualize_cta",
    productHandle: handle,
    productTitle: String(product?.title || "").trim(),
    productImage: image,
    productCategory: category,
    styleContext: recentUserStyleContext(messages),
    label: String(config.visualizeLookLabel || "").trim() || "See It Styled",
    sceneGroup,
    scenes: VISUALIZE_SCENE_GROUPS[sceneGroup],
  };
}
