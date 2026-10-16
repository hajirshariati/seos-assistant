// Product attributes picker — turns the store's metafield definitions into a
// simple "tick what the assistant should know" list. Pure (no I/O), so the
// admin page and tests share it.

import { AUTO_METAFIELD_CANDIDATES } from "../models/AttributeMapping.server.js";

// Names the assistant already understands, so a field picked from the list
// lands on the right attribute without the merchant knowing our vocabulary.
const KNOWN_NAMES = {
  gender: "gender", gender_text: "gender", attr_gender: "gender", target_gender: "gender",
  color: "color", colour: "color", color_family: "color_family", attr_color_family: "color_family",
  category: "category", attr_category: "category", category_for_filter: "category_for_filter",
  subcategory: "subcategory",
  recommended_for: "helps_with", reccomended_for: "helps_with", helps_with: "helps_with",
  activity: "activity", attr_activity_shoe_type: "activity", attr_activity_shoe_type_for_filter: "activity",
  badge: "badge", footbed: "footbed", materials_details: "materials", comfort_details: "comfort",
};

// Data the assistant can't use (links to other records, files, apps' plumbing).
const UNUSABLE_TYPES = /(^|\.)(product_reference|collection_reference|page_reference|file_reference|variant_reference|url|json|link|mixed_reference)$/;
const APP_NAMESPACES = /^(shopify--|mm-google-shopping|avalara|globo--|judgeme|yotpo|klaviyo|seo|app--)/i;
const INTERNAL_KEYS = /(^|_)(id|pimid|sku|taxcode|tax_code|code|gallery|galleryid|tooltip|chart|icons?|media|override|searchable|frontrow|template|sort|position|highlights_color_mode|related|complementary)(_|$)/i;
const LONG_TEXT = /multi_line_text_field|rich_text_field/;

export function slugAttribute(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/^attr_/, "")
    .replace(/_(for_filter|text|filter)$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function suggestAttributeName({ key = "", name = "" } = {}, taken = new Set()) {
  const k = String(key || "").toLowerCase().replace(/-/g, "_");
  let base = KNOWN_NAMES[k] || slugAttribute(k) || slugAttribute(name) || "attribute";
  if (!taken.has(base)) return base;
  const alt = slugAttribute(name);
  if (alt && !taken.has(alt)) return alt;
  for (let i = 2; i < 50; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now() % 1000}`;
}

function typeLabel(type = "") {
  const t = String(type);
  if (/metaobject_reference/.test(t)) return t.startsWith("list.") ? "List of options" : "Option";
  if (LONG_TEXT.test(t)) return "Long text";
  if (/^list\./.test(t)) return "List";
  if (/boolean/.test(t)) return "Yes / no";
  if (/number|rating|dimension|weight|volume/.test(t)) return "Number";
  return "Text";
}

// definitions: [{ name, namespace, key, description, type: { name } | string, metafieldsCount, target }]
// mappings:    existing AttributeMapping rows.
export function buildMetafieldChoices({ definitions = [], mappings = [] } = {}) {
  const mappedBy = new Map();
  for (const m of mappings) {
    if (m?.sourceType === "metafield" && m.namespace && m.key) {
      mappedBy.set(`${m.target || "product"}:${m.namespace}.${m.key}`, m.attribute);
    }
  }
  const mappedAttributes = new Set(mappings.map((m) => String(m?.attribute || "").toLowerCase()));
  const autoBy = new Map(
    AUTO_METAFIELD_CANDIDATES
      .filter((c) => !mappedAttributes.has(c.attribute))
      .map((c) => [`product:${c.namespace}.${c.key}`, c.attribute]),
  );
  const taken = new Set([...mappedAttributes, ...AUTO_METAFIELD_CANDIDATES.map((c) => c.attribute)]);

  const rows = [];
  for (const d of definitions) {
    if (!d?.namespace || !d?.key) continue;
    const target = d.target === "variant" ? "variant" : "product";
    const type = typeof d.type === "string" ? d.type : d.type?.name || "";
    const count = Number(d.metafieldsCount) || 0;
    const id = `${target}:${d.namespace}.${d.key}`;
    const mappedAs = mappedBy.get(id) || null;
    const autoAs = mappedAs ? null : autoBy.get(id) || null;

    let group = "recommended";
    let why = "";
    if (UNUSABLE_TYPES.test(type)) { group = "hidden"; why = "Links to other records"; }
    else if (APP_NAMESPACES.test(d.namespace)) { group = "hidden"; why = "Added by an app"; }
    else if (count === 0) { group = "hidden"; why = "Not filled in on any product"; }
    else if (INTERNAL_KEYS.test(d.key.replace(/-/g, "_"))) { group = "other"; why = "Looks internal"; }
    else if (LONG_TEXT.test(type)) { group = "other"; why = "Long text — helps answer questions, not for filtering"; }
    else if (count < 3) { group = "other"; why = "Only on a few products"; }

    const status = mappedAs ? "added" : autoAs ? "automatic" : "available";
    const suggested = status === "available" ? suggestAttributeName(d, taken) : mappedAs || autoAs;
    rows.push({
      id,
      target,
      namespace: d.namespace,
      key: d.key,
      name: String(d.name || d.key),
      description: String(d.description || ""),
      type,
      typeLabel: typeLabel(type),
      count,
      status,
      attribute: suggested,
      group: status === "available" ? group : "in_use",
      why,
    });
  }
  const order = { in_use: 0, recommended: 1, other: 2, hidden: 3 };
  rows.sort((a, b) => order[a.group] - order[b.group] || b.count - a.count || a.name.localeCompare(b.name));
  return rows;
}
