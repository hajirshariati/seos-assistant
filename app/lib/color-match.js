// Color matching for catalog search — reads color from where merchants
// actually keep it, with zero configuration.
//
// Live trace 2026-10-16 ("show me shoes in red good for plantar fasciitis"):
// the search color filter only read attributesJson.color, which is empty until
// the merchant configures Attribute Mappings. Aetrex keeps one product per
// colorway ("Savannah Adjustable Quarter Strap Sandal - Red") with no "Color"
// variant option, so color=red matched NOTHING, the filter was dropped, and the
// bot told the customer "we don't currently have red shoes" while six red
// plantar-fasciitis styles were in stock.
//
// Sources, in order: attributes (color / color_family), the variant "Color"
// option, and the title's trailing " - <Color>" suffix. Matching is
// word-boundary ("red" never matches "tired" or "Shredded") and falls back to a
// close-shade family ("red" → burgundy / wine) only when no exact color exists.

// Shopper color word → close catalog shades. Mirrors the availability-truth
// families; kept separate so search tuning never moves availability verdicts.
const COLOR_FAMILIES = [
  ["red", "burgundy", "wine", "maroon", "crimson", "cherry", "ruby", "scarlet"],
  ["pink", "rose", "blush", "mauve", "fuchsia", "magenta", "rose gold"],
  ["grey", "gray", "charcoal", "slate", "graphite", "pewter", "smoke"],
  ["tan", "beige", "nude", "sand", "khaki", "camel", "stone", "taupe"],
  ["brown", "chocolate", "cognac", "espresso", "mocha", "chestnut", "walnut"],
  ["navy", "blue", "denim", "indigo", "cobalt"],
  ["white", "ivory", "cream", "off white", "bone"],
  ["gold", "bronze", "copper", "metallic"],
  ["green", "olive", "sage", "mint", "emerald"],
  ["purple", "plum", "eggplant", "lavender", "violet"],
  ["black", "noir", "onyx"],
  ["yellow", "mustard", "honey"],
  ["orange", "terracotta", "rust"],
  ["silver"],
];

const ALL_COLOR_WORDS = new Set(COLOR_FAMILIES.flat());

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function colorFamilyOf(word) {
  const w = norm(word);
  return COLOR_FAMILIES.find((fam) => fam.includes(w)) || null;
}

// The color families a value reads as ("Black Sparkle" → black, "Navy/White"
// → navy and white), by each family's first word. A name no family knows
// ("Oatmeal", "Army") stands for itself — so two cards can be told apart.
export function colorFamiliesIn(value) {
  const v = norm(value);
  if (!v) return [];
  const out = COLOR_FAMILIES
    .filter((fam) => fam.some((w) => new RegExp(`\\b${escapeRe(w)}\\b`).test(v)))
    .map((fam) => fam[0]);
  return out.length ? out : [v];
}

// Colorful: a red, pink, orange, yellow, green, blue or purple (or a print),
// as against black, white, grey, navy and the browns and tans.
const BRIGHT_WORDS = [
  "red", "burgundy", "wine", "cherry", "ruby", "scarlet", "crimson", "raspberry", "berry",
  "pink", "rose", "blush", "fuchsia", "magenta", "coral", "salmon", "peach",
  "orange", "rust", "terracotta", "tangerine", "papaya",
  "yellow", "mustard", "lemon", "sunflower", "marigold",
  "green", "olive", "sage", "mint", "emerald", "lime", "jade", "forest",
  "teal", "turquoise", "aqua", "blue", "cobalt", "denim", "sky", "royal", "periwinkle", "ocean",
  "purple", "plum", "lavender", "violet", "lilac", "orchid", "grape",
  "multi", "multicolor", "rainbow", "floral", "leopard", "print",
];
export function isColorful(colorValues = []) {
  const values = (Array.isArray(colorValues) ? colorValues : [colorValues]).map(norm).filter(Boolean);
  return values.some((v) => BRIGHT_WORDS.some((w) => new RegExp(`\\b${escapeRe(w)}\\b`).test(v)));
}

// Does the value contain a known color word? Used to keep non-color title
// suffixes ("- Insole for Athletic Footwear") out of the color vocabulary.
export function containsColorWord(value) {
  const v = norm(value);
  if (!v) return false;
  for (const w of ALL_COLOR_WORDS) {
    if (new RegExp(`\\b${escapeRe(w)}\\b`).test(v)) return true;
  }
  return false;
}

// "Margot Lace-Up Boot - Dark Red" → "Dark Red". Only returned when the suffix
// reads as a color, so orthotic model suffixes never pollute color data.
export function titleSuffixColor(title) {
  const m = String(title || "").match(/\s[-–—]\s*([^–—-]{2,40})$/);
  if (!m) return null;
  const suffix = m[1].trim();
  return containsColorWord(suffix) ? suffix : null;
}

function valueHasWord(value, want) {
  const v = norm(value);
  const w = norm(want);
  if (!v || !w) return false;
  return new RegExp(`(^|[^a-z])${escapeRe(w).replace(/\s+/g, "\\s+")}([^a-z]|$)`).test(v);
}

// colorValues: every color string known for a product. wants: the requested
// color plus any merchant-configured synonyms. Returns "exact" | "family" | null.
export function matchColorValues(colorValues = [], wants = []) {
  const values = (Array.isArray(colorValues) ? colorValues : [colorValues]).filter(Boolean).map(String);
  const wantList = (Array.isArray(wants) ? wants : [wants]).map(norm).filter(Boolean);
  if (wantList.length === 0) return "exact";
  if (values.some((v) => wantList.some((w) => valueHasWord(v, w)))) return "exact";
  const family = new Set(wantList.flatMap((w) => colorFamilyOf(w) || []));
  if (family.size > 0 && values.some((v) => [...family].some((w) => valueHasWord(v, w)))) return "family";
  return null;
}

