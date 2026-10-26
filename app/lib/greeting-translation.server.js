// Multilingual welcome-CTA translator. Generates translations of the
// merchant's greetingCta into a fixed set of high-traffic Shopify
// languages on demand, then caches the result on ShopConfig so repeat
// /widget-config requests don't re-pay the model.
//
// Cache shape (stored as JSON string in ShopConfig.greetingCtaTranslations):
//   {
//     v: CACHE_VERSION,
//     phrase: "<verbatim greetingCta the cache was generated from>",
//     results: [{ code, dir, text }, ...]  // the TARGET_LANGUAGES the model returned
//   }
//
// Cache invalidation: if the cached `phrase` doesn't equal the phrase the
// widget shows, regenerate. Languages are fixed (not configurable
// per merchant) to keep the system simple and the cost bounded — six
// translations per merchant phrase change. The common default lines are
// translated by hand (greeting-curated.js) and never call the model.

import Anthropic from "@anthropic-ai/sdk";
import prisma from "../db.server";
import { forgetShopConfig } from "../models/ShopConfig.server.js";
import { DEFAULT_MODEL } from "./claude-models.js";
import { TARGET_LANGUAGES, curatedTranslations } from "./greeting-curated.js";

// Bumped when the translation method changes, so older cached translations
// are made again.
const CACHE_VERSION = 3;

// Public entry point. Returns an array of {code, dir, text}, or [] while the
// translations aren't ready (the widget then shows the phrase in English).
// Never waits on the model: a missing translation is made in the background
// and is there on a later page view. The phrase is the one the widget shows
// (the theme editor's welcome line), bounded, and the store makes at most
// one translation call every few minutes, whatever phrases come in.
const MAX_PHRASE_CHARS = 160;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const lastAttempt = new Map(); // shop -> ms

export function getGreetingCtaTranslations(config, requestedPhrase) {
  const phrase = String(requestedPhrase || config?.greetingCta || "").trim().slice(0, MAX_PHRASE_CHARS);
  if (!phrase) return [];
  const curated = curatedTranslations(phrase);
  if (curated) return curated;

  let cached = null;
  try { cached = JSON.parse(config?.greetingCtaTranslations || "{}"); } catch { /* */ }
  if (cached && cached.v === CACHE_VERSION && cached.phrase === phrase && Array.isArray(cached.results) && cached.results.length > 0) {
    return cached.results;
  }

  const apiKey = config?.anthropicApiKey;
  const now = Date.now();
  if (apiKey && now - (lastAttempt.get(config.shop) || 0) > RETRY_AFTER_MS) {
    lastAttempt.set(config.shop, now);
    translatePhrase(phrase, apiKey)
      .then((results) => {
        if (!results.length) return;
        return prisma.shopConfig.update({
          where: { shop: config.shop },
          data: { greetingCtaTranslations: JSON.stringify({ v: CACHE_VERSION, phrase, results }) },
        }).then(() => forgetShopConfig(config.shop));
      })
      .catch((err) => console.error("[greeting-translation] failed:", err?.message || err));
  }
  return [];
}

// Single model call returns all six translations as JSON. Prompt is
// strict about output shape so we don't have to do prose parsing.
async function translatePhrase(phrase, apiKey) {
  const anthropic = new Anthropic({ apiKey, timeout: 15000, maxRetries: 1 });
  const langList = TARGET_LANGUAGES
    .map((l) => `- ${l.code} (${l.name})`)
    .join("\n");

  const prompt = `You are a native-speaking retail copywriter for each language below. Rewrite this short welcome line from an online shoe store's shopping assistant so it sounds the way a friendly, polite shop assistant would naturally say it in that language — idiomatic, not word-for-word. Keep it about as short as the English and keep it a question if the English is one.

Write each one as a native speaker would phrase it from scratch, never as a translation: no calques of English structure (e.g. Persian "دنبال چه چیزی هستید" is a calque; "دنبال چه می‌گردید" is how people say it). If a native shopper would find it odd, rephrase it.

Phrase: "${phrase}"

Languages:
${langList}

Per language:
- es: neutral Latin-American Spanish, informal "tú".
- ar: Modern Standard Arabic as used on shop websites, short and warm (e.g. "عمّ تبحث اليوم؟").
- ja: polite retail Japanese as a shop greets customers (本日は…, お探しですか, ご用件).
- he: address the shopper in the plural so it isn't gendered.
- hi: everyday Devanagari Hindi; prefer "हम" or a phrasing without a gendered verb ending.
- fa: natural, polite standard Persian the way an Iranian shop assistant would write it (not stiff, not slang, not Arabic): Persian letters ی and ک, a zero-width non-joiner where Persian needs one (می‌توانم, می‌گردید), polite plural forms.

Return ONLY a JSON array with no prose, no markdown fences, no explanation. Each element must be an object with two fields: "code" (the ISO 639-1 code from the list above) and "text" (the line, no surrounding quotes). Example shape:
[{"code":"es","text":"..."},{"code":"ar","text":"..."}]`;

  const res = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = res?.content?.[0]?.text || "";
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("model returned no JSON array");

  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed)) throw new Error("model returned non-array");

  const byCode = new Map(
    parsed
      .filter((p) => p && typeof p.code === "string" && typeof p.text === "string" && p.text.trim().length > 0)
      .map((p) => [p.code.trim().toLowerCase(), p.text.trim()]),
  );

  return TARGET_LANGUAGES
    .map(({ code, dir }) => {
      const text = byCode.get(code);
      if (!text) return null;
      return { code, dir, text };
    })
    .filter(Boolean);
}
