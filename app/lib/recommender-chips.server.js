// Tap-to-answer button labels for a guided recommender question: only
// options that still lead to a product, kid-safe conditions, de-duplicated
// labels, and gender chips phrased for the tree ("Women's orthotics").

const KIDS_GENDER_VALUES = new Set(["kids", "boys", "girls", "kid", "child"]);

function isKidsGenderValue(v) {
  if (typeof v !== "string") return false;
  return KIDS_GENDER_VALUES.has(v.toLowerCase());
}

function isKidsMasterIndexEntry(m) {
  if (!m) return false;
  if (isKidsGenderValue(m.gender)) return true;
  if (typeof m.gender === "string" && m.gender.toLowerCase() === "unisex") {
    const t = String(m.title || "").toLowerCase();
    if (/\b(kid|kids|child|children|youth|boys?|girls?)\b/.test(t)) return true;
  }
  return false;
}

function entrySatisfiesAnswers(entry, answers) {
  if (!entry) return false;
  const a = answers || {};

  if (a.gender) {
    if (isKidsGenderValue(a.gender)) {
      if (!isKidsMasterIndexEntry(entry)) return false;
    } else {
      const eg = String(entry.gender || "").toLowerCase();
      const ag = String(a.gender).toLowerCase();
      if (eg !== ag && eg !== "unisex") return false;
    }
  }

  if (a.useCase) {
    const eu = String(entry.useCase || "").toLowerCase();
    const au = String(a.useCase).toLowerCase();
    if (eu !== au) return false;
  }

  if (a.arch) {
    const ea = String(entry.arch || "").toLowerCase();
    const aa = String(a.arch).toLowerCase();
    if (ea !== aa) return false;
  }

  if (String(a.overpronation || "").toLowerCase() === "yes") {
    if (!entry.posted) return false;
  }

  return true;
}

function chipsAchievableForNode(node, answers, tree) {
  const chips = Array.isArray(node?.chips) ? node.chips : [];
  if (chips.length === 0) return chips;
  const masterIndex = tree?.definition?.resolver?.masterIndex;
  if (!Array.isArray(masterIndex) || masterIndex.length === 0) return chips;
  const attr = node?.attribute;
  if (!attr) return chips;

  return chips.filter((chip) => {
    const value = chip?.value;
    if (typeof value === "string" && value.toLowerCase() === "none") return true;
    if (value === undefined || value === null) return true;
    const trial = { ...(answers || {}), [attr]: value };
    return masterIndex.some((m) => entrySatisfiesAnswers(m, trial));
  });
}

function collapseDuplicateSlashLabel(label) {
  const raw = String(label || "").trim();
  if (!raw) return raw;
  // Split on a slash (ASCII or unicode variants) or pipe.
  const parts = raw.split(/\s*[/|⁄∕／]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return raw;
  const seen = new Set();
  const kept = [];
  for (const p of parts) {
    // Aggressive key: ignore case, spaces, hyphens, and any punctuation so
    // "Ball-of-foot pain" and "ball‑of‑foot pain" (different hyphen bytes)
    // collapse. Genuinely different parts ("Flat" vs "Low") stay distinct.
    const key = p.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(p);
  }
  return kept.length === parts.length ? raw : kept.join(" / ");
}

function availableConditionsForAnswers(tree, answers) {
  const masterIndex = tree?.definition?.resolver?.masterIndex;
  if (!Array.isArray(masterIndex) || !answers) return null;
  // Adults: no condition filtering. Resolver handles all conditions
  // via specialty tests and shoe-context locks.
  if (!isKidsGenderValue(answers.gender)) return null;
  // Kids: strict filter. Only show conditions present on Kids items.
  // "none" is always allowed as the catch-all.
  const out = new Set(["none"]);
  for (const m of masterIndex) {
    if (!isKidsMasterIndexEntry(m)) continue;
    if (typeof m?.condition === "string" && m.condition) {
      out.add(m.condition);
    }
  }
  return out;
}

export function orthoticChipLabelsForAttribute(tree, attribute, answers = {}) {
  if (!tree || !tree.definition || !Array.isArray(tree.definition.nodes) || !attribute) return [];
  const node = tree.definition.nodes.find(
    (n) => n && n.type === "question" && n.attribute === attribute,
  );
  if (!node) return [];
  const NONSENSE_GENDER = /^(?:unisex|other|either|both)\b/i;
  let chips = (node.chips || []).filter((c) => {
    const label = String(c?.label || "").trim();
    return label && !NONSENSE_GENDER.test(label);
  });
  chips = chipsAchievableForNode({ ...node, chips }, answers || {}, tree);
  if (node.attribute === "condition" && answers && isKidsGenderValue(answers.gender)) {
    const allowed = availableConditionsForAnswers(tree, answers);
    if (allowed && allowed.size > 0) chips = chips.filter((c) => allowed.has(c.value));
  }
  let labels = chips
    .map((c) => collapseDuplicateSlashLabel(String(c.label).trim()))
    .filter(Boolean);
  if (node.attribute === "gender") {
    const contextNoun = getGenderChipContextNoun(tree?.definition);
    labels = labels.map((l) => decorateGenderChipLabel(l, contextNoun));
  }
  return labels;
}

function decorateGenderChipLabel(label, noun) {
  const l = String(label || "").trim();
  const n = String(noun || "").trim();
  if (!l || !n) return l;
  if (/['’]s?$/.test(l)) return `${l} ${n}`; // already possessive ("Men's", "Kids'")
  if (/s$/i.test(l)) return `${l}' ${n}`; // plural → trailing apostrophe ("Kids' orthotics")
  return `${l}'s ${n}`; // "Men's orthotics", "Women's orthotics"
}

function getGenderChipContextNoun(treeDefinition) {
  const noun = treeDefinition?.vocabulary?.genderChipContextNoun;
  if (typeof noun === "string" && noun.trim()) return noun.trim();
  return "orthotics";
}
