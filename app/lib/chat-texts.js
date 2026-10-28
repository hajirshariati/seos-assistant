// The chat's own words, set in Settings → Look & feel → Chat text: its name,
// the welcome greetings, the "Start here" / "Popular" headings, the chat
// button and the message box. Stored as one JSON object; a blank one keeps
// the theme editor's text (or the built-in default). Pure.

// [key, form field, max length, default shown as the placeholder]
export const CHAT_TEXT_FIELDS = [
  ["name", "textName", 60, "AI Shopping Assistant"],
  ["greeting", "textGreeting", 120, "Hi! I'm your personal shopping assistant."],
  ["greetingLoggedIn", "textGreetingLoggedIn", 120, "Welcome back, {name}!"],
  ["startHeading", "textStartHeading", 30, "Start here"],
  ["popularHeading", "textPopularHeading", 30, "Popular"],
  ["launcher", "textLauncher", 60, "How can I help you today?"],
  ["input", "textInput", 60, "How can I help you today?"],
];

export function cleanChatText(value, max) {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

// The stored JSON → { key: text } with only the ones set.
export function parseChatTexts(json) {
  let raw = {};
  try { raw = typeof json === "string" ? JSON.parse(json || "{}") : json || {}; } catch { raw = {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, , max] of CHAT_TEXT_FIELDS) {
    const v = cleanChatText(raw[key], max);
    if (v) out[key] = v;
  }
  return out;
}

// Form values ({ textName: "…" }) → the JSON to store.
export function chatTextsFromForm(get) {
  const out = {};
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
