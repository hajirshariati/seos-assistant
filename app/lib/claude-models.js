// The Claude models the assistant may run on. The admin picker offers these;
// anything else stored for a store (an older, deprecated snapshot) is mapped
// to the current model of the same tier, so a retirement never takes the
// chat down.
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const ALLOWED_MODELS = new Set(["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-7"]);

const REPLACEMENTS = {
  "claude-sonnet-4-20250514": "claude-sonnet-4-6",
  "claude-sonnet-4-0": "claude-sonnet-4-6",
  "claude-opus-4-20250514": "claude-opus-4-7",
  "claude-opus-4-0": "claude-opus-4-7",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

export function chatModel(stored) {
  const id = String(stored || "").trim();
  if (ALLOWED_MODELS.has(id)) return id;
  return REPLACEMENTS[id] || DEFAULT_MODEL;
}
