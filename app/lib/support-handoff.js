// Label for the "talk to a person" button. A meaningful custom label from
// Settings wins; the generic link defaults fall back to the chat wording.
export function supportChatLabel(ctx) {
  const raw = String(ctx?.supportLabel || "").trim();
  const linkDefaults = new Set(["Contact customer service", "Visit Support Hub"]);
  if (raw && !linkDefaults.has(raw)) return raw;
  return "Chat with Aetrex Support";
}
