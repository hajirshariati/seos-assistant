import prisma from "../db.server";

export async function getAttributeMappings(shop) {
  return prisma.attributeMapping.findMany({ where: { shop } });
}

export async function upsertAttributeMapping(
  shop,
  { attribute, sourceType, target, namespace, key, prefix },
) {
  const data = {
    sourceType,
    target: target || "product",
    namespace: namespace || null,
    key: key || null,
    prefix: prefix || null,
  };
  return prisma.attributeMapping.upsert({
    where: { shop_attribute: { shop, attribute } },
    update: { ...data, updatedAt: new Date() },
    create: { shop, attribute, ...data },
  });
}

export async function deleteAttributeMapping(shop, attribute) {
  return prisma.attributeMapping.deleteMany({ where: { shop, attribute } });
}

function filterMetafieldMappings(mappings, target) {
  return mappings.filter(
    (m) =>
      m.sourceType === "metafield" &&
      m.namespace &&
      m.key &&
      (m.target || "product") === target,
  );
}

export function buildMetafieldFragment(mappings, target = "product") {
  const metafieldMappings = filterMetafieldMappings(mappings, target);
  if (metafieldMappings.length === 0) return "";
  return metafieldMappings
    .map(
      (m, i) =>
        `attr_${i}: metafield(namespace: "${m.namespace}", key: "${m.key}") {
          value
          type
          reference { ... on Metaobject { handle displayName } }
          references(first: 10) { nodes { ... on Metaobject { handle displayName } } }
        }`,
    )
    .join("\n        ");
}

export function resolveMetafieldValue(metafield) {
  if (!metafield) return null;

  const refs = metafield.references?.nodes || [];
  if (refs.length > 0) {
    const values = refs
      .map((n) => n?.displayName || n?.handle || "")
      .filter(Boolean)
      .map((v) => v.toLowerCase());
    return values.length === 1 ? values[0] : values;
  }

  const ref = metafield.reference;
  if (ref) {
    return (ref.displayName || ref.handle || "").toLowerCase() || null;
  }

  const raw = metafield.value;
  if (!raw) return null;

  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        const vals = arr
          .map((v) => {
            if (typeof v === "string") {
              if (v.startsWith("gid://")) return null;
              return v.toLowerCase().trim();
            }
            return String(v).toLowerCase().trim();
          })
          .filter(Boolean);
        return vals.length === 1 ? vals[0] : vals.length > 0 ? vals : null;
      }
    } catch {}
  }

  if (trimmed.startsWith("gid://")) return null;
  return trimmed.toLowerCase();
}

export function resolveProductAttributes(node, mappings) {
  if (!mappings || mappings.length === 0) return null;

  const attrs = {};
  const metafieldMappings = filterMetafieldMappings(mappings, "product");
  const tagMappings = mappings.filter((m) => m.sourceType === "tag_prefix" && m.prefix);

  for (let i = 0; i < metafieldMappings.length; i++) {
    const mapping = metafieldMappings[i];
    const mf = node[`attr_${i}`];
    const val = resolveMetafieldValue(mf);
    if (val != null) attrs[mapping.attribute] = val;
  }

  const tags = node.tags || [];
  for (const mapping of tagMappings) {
    const prefix = mapping.prefix.toLowerCase();
    for (const tag of tags) {
      const t = (typeof tag === "string" ? tag : "").toLowerCase().trim();
      if (t.startsWith(prefix)) {
        const val = t.slice(prefix.length).trim();
        if (val) {
          if (attrs[mapping.attribute]) {
            const existing = Array.isArray(attrs[mapping.attribute])
              ? attrs[mapping.attribute]
              : [attrs[mapping.attribute]];
            existing.push(val);
            attrs[mapping.attribute] = existing;
          } else {
            attrs[mapping.attribute] = val;
          }
        }
      }
    }
  }

  return Object.keys(attrs).length > 0 ? attrs : null;
}

// ── Zero-config attribute discovery ────────────────────────────────
// A merchant who hasn't configured Attribute Mappings yet still keeps color,
// gender and category in common metafields (Aetrex: custom.color="red",
// custom.gender_text="Women", custom.category_for_filter="Sandals"). Without
// them attributesJson was null, so "red shoes" matched nothing and the gender
// filter could only read titles — where only orthotics say "Women's". These
// candidates are read for any attribute the merchant has NOT mapped; an
// explicit mapping always wins. One `metafield(...)` lookup per candidate.
export const AUTO_METAFIELD_CANDIDATES = [
  { attribute: "color", namespace: "custom", key: "color" },
  { attribute: "color", namespace: "custom", key: "colour" },
  { attribute: "color_family", namespace: "custom", key: "color_family" },
  { attribute: "color_family", namespace: "custom", key: "attr_color_family" },
  { attribute: "gender", namespace: "custom", key: "gender" },
  { attribute: "gender", namespace: "custom", key: "gender_text" },
  { attribute: "category_for_filter", namespace: "custom", key: "category_for_filter" },
  { attribute: "subcategory", namespace: "custom", key: "subcategory" },
  // Conditions the product is made for → helps_with (read by catalog facts
  // alongside tags). Aetrex: product.reccomended_for (sic).
  { attribute: "helps_with", namespace: "custom", key: "helps_with" },
  { attribute: "helps_with", namespace: "custom", key: "recommended_for" },
  { attribute: "helps_with", namespace: "product", key: "recommended_for" },
  { attribute: "helps_with", namespace: "product", key: "reccomended_for" },
  // Occasion / use case → activity (read by catalog facts use-case tags).
  { attribute: "activity", namespace: "custom", key: "activity" },
  { attribute: "activity", namespace: "custom", key: "attr_activity_shoe_type_for_filter" },
  { attribute: "badge", namespace: "custom", key: "badge" },
];

export function autoMetafieldCandidates(mappings = []) {
  const mapped = new Set((mappings || []).map((m) => String(m?.attribute || "").toLowerCase()));
  return AUTO_METAFIELD_CANDIDATES.filter((c) => !mapped.has(c.attribute));
}

export function buildAutoMetafieldFragment(mappings = []) {
  return autoMetafieldCandidates(mappings)
    .map((c, i) => `auto_${i}: metafield(namespace: "${c.namespace}", key: "${c.key}") { value }`)
    .join("\n        ");
}

export function resolveAutoAttributes(node, mappings = []) {
  const attrs = {};
  autoMetafieldCandidates(mappings).forEach((c, i) => {
    if (attrs[c.attribute] != null) return;
    const val = resolveMetafieldValue(node?.[`auto_${i}`]);
    if (val != null && val !== "" && !(Array.isArray(val) && val.length === 0)) attrs[c.attribute] = val;
  });
  return Object.keys(attrs).length > 0 ? attrs : null;
}

export function resolveVariantAttributes(variantNode, mappings) {
  if (!mappings || mappings.length === 0) return null;

  const metafieldMappings = filterMetafieldMappings(mappings, "variant");
  if (metafieldMappings.length === 0) return null;

  const attrs = {};
  for (let i = 0; i < metafieldMappings.length; i++) {
    const mapping = metafieldMappings[i];
    const mf = variantNode[`attr_${i}`];
    const val = resolveMetafieldValue(mf);
    if (val != null) attrs[mapping.attribute] = val;
  }
  return Object.keys(attrs).length > 0 ? attrs : null;
}
