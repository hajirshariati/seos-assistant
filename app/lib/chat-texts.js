// The chat's own words, set in Settings → Look & feel → Chat text: its name
// (and an optional smaller line under it), the greetings, the line under the
// greeting, the chat button, the message box, the product cards' fit & size
// button, the footer note — and every word on the Focus home (its three
// cards and the three links above the message box). Stored as one JSON
// object; a blank one keeps the built-in text. Pure.
//
// The Classic home's own words (its Start here / Popular buttons and
// headings) are no longer settings: they're built in, as the store had them.
// Headings an older save holds are kept as they are (LEGACY_KEYS), so the
// Classic home doesn't change.

// Who the assistant says it is, whatever the chat's header shows: Ava, the
// Aetrex Virtual Assistant. Built in (the system prompt), not a setting.
export const ASSISTANT_NAME = "Ava";
export const ASSISTANT_TITLE = "Aetrex Virtual Assistant";

// [key, form field, max length, default shown as the placeholder]
export const CHAT_TEXT_FIELDS = [
  ["name", "textName", 60, "AI Shopping Assistant"],
  ["nameSub", "textNameSub", 60, ""],
  ["greeting", "textGreeting", 120, "Hi! I'm your personal shopping assistant."],
  ["greetingLoggedIn", "textGreetingLoggedIn", 120, "Welcome back, {name}!"],
  // The greeting on phones (blank: the one above everywhere); the signed-in one still wins.
  ["greetingPhone", "textGreetingPhone", 120, ""],
  ["greetingCta", "textGreetingCta", 80, "How can I help you today?"],
  ["launcher", "textLauncher", 60, "How can I help you today?"],
  ["input", "textInput", 60, "How can I help you today?"],
  ["fitButton", "textFitButton", 24, "Check fit & size"],
  ["disclaimer", "textDisclaimer", 300, "Powered by AI"],
  // Focus home: the three cards…
  ["homePainEyebrow", "textHomePainEyebrow", 30, "Help me with"],
  ["homePainTitle", "textHomePainTitle", 40, "Foot pain"],
  ["homePainTitleWide", "textHomePainTitleWide", 60, "Let’s talk about your foot pain."],
  ["homePainSub", "textHomePainSub", 120, "Say where it hurts and what you wear. A few taps, then Ava’s best match."],
  ["homePainCta", "textHomePainCta", 16, "Start"],
  ["homeFootwearEyebrow", "textHomeFootwearEyebrow", 30, "Help me find"],
  ["homeFootwearTitle", "textHomeFootwearTitle", 40, "Footwear"],
  ["homeFootwearSub", "textHomeFootwearSub", 120, "Sneakers, sandals, boots and more — support built in."],
  ["homeFootwearCta", "textHomeFootwearCta", 16, "Browse"],
  ["homeOrthoticsEyebrow", "textHomeOrthoticsEyebrow", 30, "Help me find"],
  ["homeOrthoticsTitle", "textHomeOrthoticsTitle", 40, "Orthotics"],
  ["homeOrthoticsSub", "textHomeOrthoticsSub", 120, "Inserts for the shoes you already own, matched to your arch."],
  ["homeOrthoticsCta", "textHomeOrthoticsCta", 16, "Browse"],
  // …and the three links above the message box (what it says, what it sends).
  ["homeLink1Label", "textHomeLink1Label", 30, ""],
  ["homeLink1Message", "textHomeLink1Message", 160, ""],
  ["homeLink2Label", "textHomeLink2Label", 30, "Returns & exchanges"],
  ["homeLink2Message", "textHomeLink2Message", 160, "I’d like to return or exchange something."],
  ["homeLink3Label", "textHomeLink3Label", 30, "Deals"],
  ["homeLink3Message", "textHomeLink3Message", 160, "What deals are running right now?"],
];

// What the AVA app (Aetrex) shows when a field is blank: the words its
// theme editor held when these moved here. Placeholders on its Settings.
export const AVA_TEXT_DEFAULTS = {
  name: "Aetrex Virtual Assistant",
  greeting: "Hi! I'm Ava, your personal shopping assistant.",
  greetingLoggedIn: "Welcome back, {name}!",
  greetingCta: "How can I help you today?",
  launcher: "What can I help you find today?",
  input: "Chat with Aetrex virtual assistant",
  disclaimer: "Virtual assistant responses may be inaccurate and are not medical advice. Chats may be recorded and shared with third-party providers. Do not share sensitive personal, payment, or health information. See our",
};

// Kept from older saves, no longer edited: the Classic home's headings.
export const LEGACY_KEYS = [["startHeading", 30], ["popularHeading", 30]];

export function cleanChatText(value, max) {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

function rawObject(json) {
  let raw = {};
  try { raw = typeof json === "string" ? JSON.parse(json || "{}") : json || {}; } catch { raw = {}; }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

// The stored JSON → { key: text } with only the ones set (legacy ones too).
export function parseChatTexts(json) {
  const raw = rawObject(json);
  const out = {};
  for (const [key, , max] of [...CHAT_TEXT_FIELDS, ...LEGACY_KEYS.map(([k, m]) => [k, null, m])]) {
    const v = cleanChatText(raw[key], max);
    if (v) out[key] = v;
  }
  return out;
}

// Form values ({ textName: "…" }) → the JSON to store. `previous` (the
// stored JSON) keeps the legacy keys the form no longer shows.
export function chatTextsFromForm(get, previous = "{}") {
  const out = {};
  const prev = parseChatTexts(previous);
  for (const [key] of LEGACY_KEYS) if (prev[key]) out[key] = prev[key];
  for (const [key, field, max] of CHAT_TEXT_FIELDS) {
    const v = cleanChatText(get(field), max);
    if (v) out[key] = v;
  }
  return JSON.stringify(out);
}

// For the Settings form: every field, "" when not set.
export function chatTextsForForm(json) {
  const set = parseChatTexts(json);
  return Object.fromEntries(CHAT_TEXT_FIELDS.map(([key, field]) => [field, set[key] || ""]));
}
