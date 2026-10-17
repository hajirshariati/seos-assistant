// Multilingual welcome-CTA translator. Generates translations of the
// merchant's greetingCta into a fixed set of high-traffic Shopify
// languages on demand, then caches the result on ShopConfig so repeat
// /widget-config requests don't re-pay the model.
//
// Cache shape (stored as JSON string in ShopConfig.greetingCtaTranslations):
//   {
//     phrase: "<verbatim greetingCta the cache was generated from>",
//     results: [{ code, dir, text }, ...]  // the TARGET_LANGUAGES the model returned
//   }
//
// Cache invalidation: if the cached `phrase` doesn't equal the phrase the
// widget shows, regenerate. Languages are fixed (not configurable
// per merchant) to keep the system simple and the cost bounded — six
// translations per merchant phrase change.

import Anthropic from "@anthropic-ai/sdk";
import prisma from "../db.server";

// Fixed set of target languages. RTL flag drives `dir="rtl"` on the
// rendered span so glyph order is correct in Arabic, Hebrew, Farsi.
// Code (ISO 639-1) drives the `lang` attribute for screen readers.
const TARGET_LANGUAGES = [
  { code: "es", name: "Spanish", dir: "ltr" },
  { code: "ar", name: "Arabic", dir: "rtl" },
  { code: "ja", name: "Japanese", dir: "ltr" },
  { code: "he", name: "Hebrew", dir: "rtl" },
  { code: "hi", name: "Hindi", dir: "ltr" },
  { code: "fa", name: "Farsi (Persian)", dir: "rtl" },
];

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

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

  let cached = null;
  try { cached = JSON.parse(config?.greetingCtaTranslations || "{}"); } catch { /* */ }
  if (cached && cached.phrase === phrase && Array.isArray(cached.results) && cached.results.length > 0) {
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
          data: { greetingCtaTranslations: JSON.stringify({ phrase, results }) },
        });
      })
      .catch((err) => console.error("[greeting-translation] failed:", err?.message || err));
  }
  return [];
}

// Single Haiku call returns all six translations as JSON. Prompt is
// strict about output shape so we don't have to do prose parsing.
async function translatePhrase(phrase, apiKey) {
  const anthropic = new Anthropic({ apiKey, timeout: 15000, maxRetries: 1 });
  const langList = TARGET_LANGUAGES
    .map((l) => `- ${l.code} (${l.name})`)
    .join("\n");

  const prompt = `Translate the following English phrase into each of the languages below. Preserve the conversational tone (a friendly retail assistant greeting a customer). Use gender-neutral phrasing where the target language allows it.

Phrase: "${phrase}"

Languages:
${langList}

Return ONLY a JSON array with no prose, no markdown fences, no explanation. Each element must be an object with two fields: "code" (the ISO 639-1 code from the list above) and "text" (the translated phrase, no surrounding quotes). Example shape:
[{"code":"es","text":"..."},{"code":"ar","text":"..."}]`;

  const res = await anthropic.messages.create({
    model: HAIKU_MODEL,
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
