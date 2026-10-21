// Languages the welcome line rotates through, and hand-written translations
// of the lines most stores keep. Pure (no server imports) so it can be tested.

// Fixed set of target languages. RTL flag drives `dir="rtl"` on the
// rendered span so glyph order is correct in Arabic, Hebrew, Farsi.
// Code (ISO 639-1) drives the `lang` attribute for screen readers.
export const TARGET_LANGUAGES = [
  { code: "es", name: "Spanish", dir: "ltr" },
  { code: "ar", name: "Arabic", dir: "rtl" },
  { code: "ja", name: "Japanese", dir: "ltr" },
  { code: "he", name: "Hebrew", dir: "rtl" },
  { code: "hi", name: "Hindi", dir: "ltr" },
  { code: "fa", name: "Farsi (Persian)", dir: "rtl" },
];

// The welcome lines most stores keep, translated by hand: natural, idiomatic
// shop talk rather than word-for-word (the machine Persian read stiffly).
// A store's own phrase is translated by the model, cached per phrase.
const CURATED = {
  "what can i help you find today": {
    es: "¿Qué te ayudo a encontrar hoy?",
    ar: "ما الذي تبحث عنه اليوم؟",
    ja: "今日は何をお探しですか？",
    he: "מה תרצו למצוא היום?",
    hi: "आज आप क्या ढूँढ रहे हैं?",
    fa: "امروز دنبال چه چیزی هستید؟",
  },
  "how can i help you today": {
    es: "¿En qué puedo ayudarte hoy?",
    ar: "كيف يمكنني مساعدتك اليوم؟",
    ja: "今日はどのようにお手伝いできますか？",
    he: "איך אפשר לעזור היום?",
    hi: "आज हम आपकी क्या मदद कर सकते हैं?",
    fa: "امروز چطور می\u200cتوانم کمکتان کنم؟",
  },
  "what can i help you with today": {
    es: "¿En qué te puedo ayudar hoy?",
    ar: "بماذا يمكنني مساعدتك اليوم؟",
    ja: "今日はどのようなお手伝いができますか？",
    he: "במה אפשר לעזור היום?",
    hi: "आज हम आपकी किस चीज़ में मदद कर सकते हैं?",
    fa: "امروز چه کمکی از دستم برمی\u200cآید؟",
  },
  "what are you looking for today": {
    es: "¿Qué estás buscando hoy?",
    ar: "ما الذي تبحث عنه اليوم؟",
    ja: "今日は何をお探しですか？",
    he: "מה אתם מחפשים היום?",
    hi: "आज आप क्या ढूँढ रहे हैं?",
    fa: "امروز دنبال چه چیزی هستید؟",
  },
};
// Same line without "today", or with "may": the same translation.
CURATED["how can i help you"] = CURATED["how can i help you today"];
CURATED["how may i help you today"] = CURATED["how can i help you today"];
CURATED["what can i help you find"] = CURATED["what can i help you find today"];
CURATED["what can i help you with"] = CURATED["what can i help you with today"];
export function phraseKey(phrase) {
  return String(phrase || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
}
export function curatedTranslations(phrase) {
  const set = CURATED[phraseKey(phrase)];
  return set ? TARGET_LANGUAGES.map(({ code, dir }) => ({ code, dir, text: set[code] })) : null;
}
