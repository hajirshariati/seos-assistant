// Orthotic finder — built straight from the live catalog, nothing mapped by hand.
//
// Aetrex encodes the fit in every orthotic's SKU (their own published rule):
// a style number ending in 00 or 05 is for medium/high arches, 20 or 25 for
// low arches / flat feet (posted heel), and 05 or 25 adds a metatarsal pad for
// ball-of-foot pain. "Posted" / "Metatarsal" in the title says the same.
//
// So the job splits cleanly:
//   - Claude picks the LINE (Speed, Train, Dress, Conform…) from the shoes,
//     activity and needs, reading each line's own "Best for" text.
//   - This code picks the exact VERSION in that line from gender, arch and
//     ball-of-foot pain, and says honestly when a version doesn't exist.
//
// Pure: no DB, no network. orthotic-finder.server.js fetches and stores.

const GENDER_WORDS = /^(men'?s|women'?s|unisex|kids'?|boys'?|girls'?)\s+/i;

function clean(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function listValue(raw) {
  if (Array.isArray(raw)) return raw.map(clean).filter(Boolean);
  const v = String(raw || "").trim();
  if (!v) return [];
  if (v.startsWith("[")) {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(clean).filter(Boolean) : []; } catch { /* plain text */ }
  }
  return [clean(v)];
}

// "L1925W05" → family "L19", code "25". "PFKM07" has no style code.
export function skuParts(sku) {
  const m = String(sku || "").toUpperCase().match(/^([A-Z]+?)(\d{3,4})/);
  if (!m) return { family: null, code: null };
  return { family: m[1] + m[2].slice(0, -2), code: m[2].slice(-2) };
}

// "Women's Casual Comfort Posted Orthotics W/ Metatarsal Support" → "Casual Comfort"
export function lineStem(title) {
  let t = clean(title)
    .replace(/^first generation\s+/i, "")
    .replace(/^bauer aetrex\s+/i, "")
    .replace(GENDER_WORDS, "");
  t = t.split(/\s+-\s+/)[0]
    .replace(/\bw\/.*$/i, "")
    .replace(/\bmed\/high arch\b/i, "")
    .replace(/\bposted\b/gi, "")
    .replace(/\b(orthotics?|insoles?)\b/gi, "")
    .replace(/^\s*for\s+/i, "");
  return t.replace(/\s+/g, " ").trim();
}

function tagline(title) {
  const parts = clean(title).split(/\s+-\s+/);
  return parts.length > 1 ? parts.slice(1).join(" - ") : "";
}

export function genderOf(title, genderText) {
  const t = clean(title);
  if (/\b(kids?|children|youth)\b/i.test(t)) return "Kids";
  const g = clean(genderText).toLowerCase();
  if (/^(men|male)/.test(g)) return "Men";
  if (/^(women|female)/.test(g)) return "Women";
  if (/unisex/.test(g)) return "Unisex";
  if (/\bwomen'?s\b/i.test(t)) return "Women";
  if (/\bmen'?s\b/i.test(t)) return "Men";
  if (/\bunisex\b/i.test(t)) return "Unisex";
  return null;
}

// Arch and metatarsal pad from the title, then the SKU code. null arch = the
// product doesn't come in arch-specific versions (e.g. a kit).
export function fitOf(title, sku) {
  const t = clean(title);
  const { code } = skuParts(sku);
  const posted = /\bposted\b|overpronation|flat feet/i.test(t) || code === "20" || code === "25";
  const metSupport = /metatars/i.test(t) || code === "05" || code === "25";
  const arch = posted ? "flat_low" : (code && ["00", "05"].includes(code)) ? "medium_high" : null;
  return { arch, metSupport };
}

// One product node from ORTHOTIC_PRODUCTS_QUERY (orthotic-finder.server.js).
export function productFromNode(n) {
  const v = n?.variants?.nodes?.[0] || {};
  return {
    title: n?.title,
    handle: n?.handle,
    sku: v.sku || "",
    price: v.price ?? null,
    gender: n?.gender?.value || "",
    activity: n?.activity?.value || "",
    details: n?.details?.value || "",
    helps: n?.helps?.value || "",
    summary: n?.summary?.value || "",
  };
}

// "<li>Recommended for: …</li><li>Best for: Running shoes, Tennis shoes</li>"
// → "Running shoes, Tennis shoes" (one list item only — later items are usage tips).
function bestForOf(details) {
  for (const part of String(details || "").split(/<\/li>|<br\s*\/?>|\n/i)) {
    const m = clean(part).match(/^best for:?\s*(.+)$/i);
    if (m) return m[1].replace(/[\s.]+$/, "").trim();
  }
  return "";
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] || "";
}

// products: [{ title, handle, sku, price, gender, activity, details, helps, summary }]
// (activity/helps may be JSON list strings or arrays).
export function buildOrthoticCatalog(products = []) {
  const items = [];
  const skipped = [];
  for (const p of products) {
    const title = clean(p?.title);
    if (!title || !p?.handle) continue;
    const gender = genderOf(title, p.gender);
    if (!gender) { skipped.push({ title, reason: "Can't tell who it's for (no gender in the title or gender field)." }); continue; }
    const { family } = skuParts(p.sku);
    const stem = lineStem(title);
    const fit = fitOf(title, p.sku);
    items.push({
      handle: p.handle,
      title,
      sku: p.sku || "",
      price: p.price != null && p.price !== "" ? Number(p.price) : null,
      gender,
      arch: fit.arch,
      metSupport: fit.metSupport,
      family: family || slug(stem || title),
      stem,
      tagline: tagline(title),
      activity: listValue(p.activity),
      helps: listValue(p.helps),
      bestFor: bestForOf(p.details),
      summary: clean(p.summary).slice(0, 260),
    });
  }

  // A line is a style family (L6xx = Casual Comfort). Within a family, names
  // that differ only by gender ("In-Style" for men, "Fashion" for women) or by
  // a word ("Casual" / "Casual Comfort") are one line; genuinely different
  // products sharing a family number (Work vs. Overpronation) stay apart.
  const byFamily = new Map();
  for (const it of items) {
    if (!byFamily.has(it.family)) byFamily.set(it.family, []);
    byFamily.get(it.family).push(it);
  }
  const groups = [];
  for (const famItems of byFamily.values()) {
    const stems = new Map();
    for (const it of famItems) {
      const key = it.stem.toLowerCase();
      if (!stems.has(key)) stems.set(key, []);
      stems.get(key).push(it);
    }
    const famGroups = [...stems.values()].map((list) => ({ items: list, genders: new Set(list.map((i) => i.gender)) }));
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < famGroups.length; i++) {
        for (let j = i + 1; j < famGroups.length; j++) {
          const a = famGroups[i], b = famGroups[j];
          const sa = a.items[0].stem.toLowerCase(), sb = b.items[0].stem.toLowerCase();
          const disjoint = [...a.genders].every((g) => !b.genders.has(g));
          const sameWords = sa.startsWith(sb) || sb.startsWith(sa);
          if (disjoint || sameWords) {
            a.items.push(...b.items);
            for (const g of b.genders) a.genders.add(g);
            famGroups.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
    groups.push(...famGroups);
  }

  const lines = [];
  const usedIds = new Set();
  for (const g of groups) {
    const list = g.items.sort((a, b) => a.sku.localeCompare(b.sku));
    // Name: the stems that differ by gender read "Fashion / In-Style"; word
    // variants take the most common one.
    const stemsByGender = [...new Set(list.map((i) => i.stem).filter(Boolean))];
    const disjointNames = stemsByGender.length > 1 && stemsByGender.every((s) => {
      const gs = new Set(list.filter((i) => i.stem === s).map((i) => i.gender));
      return stemsByGender.every((o) => o === s || list.filter((i) => i.stem === o).every((i) => !gs.has(i.gender)));
    });
    let name = disjointNames ? stemsByGender.sort().join(" / ") : mostCommon(list.map((i) => i.stem));
    if (!name) name = list[0].gender === "Kids" ? "Kids" : list[0].title;
    let id = slug(name) || slug(list[0].family);
    if (usedIds.has(id)) id = `${id}-${slug(list[0].family)}`;
    usedIds.add(id);
    const prices = list.map((i) => i.price).filter((n) => Number.isFinite(n));
    const genders = ["Men", "Women", "Unisex", "Kids"].filter((x) => list.some((i) => i.gender === x));
    for (const it of list) it.line = id;
    lines.push({
      id,
      name,
      genders,
      bestFor: mostCommon(list.map((i) => i.bestFor)),
      taglines: [...new Set(list.map((i) => i.tagline).filter(Boolean))].slice(0, 3),
      activity: [...new Set(list.flatMap((i) => i.activity))],
      helps: [...new Set(list.flatMap((i) => i.helps))],
      summary: list.find((i) => i.summary)?.summary || "",
      priceFrom: prices.length ? Math.min(...prices) : null,
      priceTo: prices.length ? Math.max(...prices) : null,
      archVersions: [...new Set(list.map((i) => i.arch).filter(Boolean))].sort(),
      hasMetVersion: list.some((i) => i.metSupport),
      hasNoMetVersion: list.some((i) => !i.metSupport),
      count: list.length,
    });
  }
  lines.sort((a, b) => a.name.localeCompare(b.name));
  return {
    lines,
    items: items.map(({ stem, family, ...rest }) => rest),
    skipped,
  };
}

const ARCH_LABEL = { flat_low: "low arches / flat feet (posted)", medium_high: "medium to high arches" };
const GENDER_LABEL = { men: "Men", women: "Women", kids: "Kids" };

function money(n) {
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "";
}

export function describeLine(line) {
  const who = line.genders.map((g) => (g === "Unisex" ? "Men & Women (unisex)" : g)).join(", ");
  const price = line.priceFrom == null ? "" : line.priceFrom === line.priceTo ? money(line.priceFrom) : `${money(line.priceFrom)}–${money(line.priceTo)}`;
  const bits = [`${line.id}: ${line.name} — for ${who}${price ? `, ${price}` : ""}.`];
  if (line.taglines.length) bits.push(line.taglines.join("; ") + ".");
  if (line.bestFor) bits.push(`Best for: ${line.bestFor}.`);
  else if (line.activity.length) bits.push(`Activity: ${line.activity.join(", ")}.`);
  if (line.helps.length) bits.push(`Helps with: ${line.helps.join(", ")}.`);
  const versions = [];
  if (line.archVersions.length === 2) versions.push("Versions for medium/high arches and for flat/low arches (posted)");
  else if (line.archVersions.length === 1) versions.push(`Only for ${ARCH_LABEL[line.archVersions[0]]}`);
  if (line.hasMetVersion && line.hasNoMetVersion) versions.push("with or without a metatarsal pad");
  else if (line.hasMetVersion) versions.push("always with a metatarsal pad");
  if (versions.length) bits.push(`${versions.join(", ")}.`);
  return bits.join(" ");
}

function genderFits(itemGender, want) {
  if (want === "kids") return itemGender === "Kids";
  if (itemGender === "Kids") return false;
  return itemGender === GENDER_LABEL[want] || itemGender === "Unisex";
}

// ── FITs (FITFinder) ─────────────────────────────────────────────────────
// FITFinder names the same four versions as FITs: by default FIT A = 20
// (posted), B = 00 (cushioned), C = 05 (cushioned + metatarsal pad), D = 25
// (posted + metatarsal pad). The storefront chat reads the store's live FIT
// names, quiz questions and the shopper's saved FIT from FITFinder and sends
// them along; this keeps them short and well-formed (it came from a browser).
const cut = (v, n) => clean(v).replace(/[<>{}]/g, "").slice(0, n);

export function sanitizeFitfinder(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fits = (Array.isArray(raw.fits) ? raw.fits : [])
    .map((f) => ({
      key: String(f?.key || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 2),
      label: cut(f?.label, 30),
      code: String(f?.code || "").replace(/\D/g, "").slice(0, 2),
      name: cut(f?.name, 80),
      description: cut(f?.description, 300),
    }))
    .filter((f) => f.key && f.label && f.code.length === 2)
    .slice(0, 8);
  if (fits.length === 0) return null;
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .map((q) => ({
      text: cut(q?.text, 160),
      help: cut(q?.helpText || q?.help, 400),
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => cut([o?.label, o?.sublabel].filter(Boolean).join(" — "), 70)).filter(Boolean).slice(0, 4),
    }))
    .filter((q) => q.text)
    .slice(0, 4);
  const savedKey = String(raw.saved?.key || "").toUpperCase();
  const saved = fits.find((f) => f.key === savedKey) || null;
  return { fits, questions, saved: saved ? saved.key : null };
}

// The FIT code of a version: arch + metatarsal pad, in Aetrex's numbering.
export function fitCode({ arch, metSupport }) {
  if (!arch) return null;
  return arch === "flat_low" ? (metSupport ? "25" : "20") : (metSupport ? "05" : "00");
}

function fromCode(code) {
  return { arch: code === "20" || code === "25" ? "flat_low" : "medium_high", ball_of_foot_pain: code === "05" || code === "25" ? "yes" : "no" };
}

function fitInfo(fits, code) {
  const f = (fits || []).find((x) => x.code === code);
  return f ? { key: f.key, label: f.label, name: f.name, description: f.description } : null;
}

// answers: { line, gender: men|women|kids, arch: flat_low|medium_high|not_sure,
//            ball_of_foot_pain: yes|no, fit: FIT key }
// available(handle) → false drops products that aren't for sale right now.
// fits: the store's FITs (sanitizeFitfinder) — picks then carry their FIT, a
// known FIT stands in for arch + ball-of-foot, and with no line yet the
// answer is just the shopper's FIT.
export function pickOrthotic(catalog, answers = {}, { available = () => true, fits = null } = {}) {
  const lines = catalog?.lines || [];
  const givenFit = fits && answers.fit ? fits.find((f) => f.key === String(answers.fit).toUpperCase()) : null;
  if (givenFit) {
    const implied = fromCode(givenFit.code);
    answers = {
      ...answers,
      arch: answers.arch === "flat_low" || answers.arch === "medium_high" ? answers.arch : implied.arch,
      ball_of_foot_pain: answers.ball_of_foot_pain === "yes" || answers.ball_of_foot_pain === "no" ? answers.ball_of_foot_pain : implied.ball_of_foot_pain,
    };
  }
  const archKnown = answers.arch === "flat_low" || answers.arch === "medium_high";
  const metKnown = answers.ball_of_foot_pain === "yes" || answers.ball_of_foot_pain === "no";

  if (!answers.line && fits) {
    if (!archKnown || !metKnown) {
      return { error: "To work out their FIT, ask whether they have flat feet and whether they have ball-of-foot pain (one question at a time)." };
    }
    const fit = fitInfo(fits, fitCode({ arch: answers.arch, metSupport: answers.ball_of_foot_pain === "yes" }));
    return {
      fit,
      instruction: "Tell them their FIT and what it means in a sentence. To choose the exact orthotic, ask who it's for and which shoes it's for (if you don't know yet), then call again with the line.",
    };
  }

  const line = lines.find((l) => l.id === answers.line);
  if (!line) return { error: `Unknown line "${answers.line}". Use one of: ${lines.map((l) => l.id).join(", ")}.` };
  const gender = String(answers.gender || "").toLowerCase();
  if (!GENDER_LABEL[gender]) return { error: "Ask who the orthotic is for (men, women or kids) before calling." };

  const inLine = catalog.items.filter((i) => i.line === line.id && available(i.handle));
  const forThem = inLine.filter((i) => genderFits(i.gender, gender));
  if (forThem.length === 0) {
    const alternatives = lines
      .filter((l) => l.id !== line.id && catalog.items.some((i) => i.line === l.id && genderFits(i.gender, gender) && available(i.handle)))
      .map((l) => l.id);
    return {
      error: inLine.length
        ? `The ${line.name} line isn't made for ${gender} (it's for ${line.genders.join(", ")}). Tell the customer, then pick the closest line that is: ${alternatives.join(", ")}.`
        : `Nothing in the ${line.name} line is for sale right now. Pick the closest other line: ${alternatives.join(", ")}.`,
      linesForThisCustomer: alternatives,
    };
  }

  const wantArch = archKnown ? answers.arch : "medium_high";
  const wantMet = String(answers.ball_of_foot_pain || "").toLowerCase() === "yes";
  const exactGender = GENDER_LABEL[gender];
  const score = (i) =>
    (i.arch === null || i.arch === wantArch ? 4 : 0) + (i.metSupport === wantMet ? 2 : 0) + (i.gender === exactGender ? 1 : 0);
  const ranked = [...forThem].sort((a, b) => score(b) - score(a) || a.sku.localeCompare(b.sku));
  const pick = ranked[0];

  const notes = [];
  if (pick.arch && pick.arch !== wantArch) {
    notes.push(`The ${line.name} line has no ${ARCH_LABEL[wantArch]} version for ${gender}; this one is for ${ARCH_LABEL[pick.arch]}. Say so plainly and offer another line if arch support matters more than the shoe type.`);
  }
  if (pick.metSupport !== wantMet) {
    notes.push(wantMet
      ? `There's no version with a metatarsal pad for ${gender} in this line — say so.`
      : `This line only comes with a metatarsal pad for ${gender} — say so.`);
  }
  if (!archKnown && inLine.some((i) => i.arch === "flat_low")) {
    notes.push("Their arch type is unknown, so this is the medium/high-arch version. Mention that the posted version is for low arches, flat feet or feet that roll inward.");
  }

  const fmt = (i) => ({
    handle: i.handle,
    title: i.title,
    price: i.price,
    arch: i.arch ? ARCH_LABEL[i.arch] : "any arch",
    metatarsalPad: i.metSupport,
    ...(fits && fitInfo(fits, fitCode(i)) ? { fit: fitInfo(fits, fitCode(i)).label } : {}),
  });
  // The shopper's FIT from their answers (not the product's — those differ
  // only when a version doesn't exist, which the notes already say).
  const theirFit = fits && archKnown && metKnown
    ? fitInfo(fits, fitCode({ arch: answers.arch, metSupport: wantMet }))
    : null;
  return {
    line: line.name,
    ...(theirFit ? { fit: theirFit } : {}),
    pick: fmt(pick),
    otherVersions: ranked.slice(1).filter((i) => i.gender === pick.gender || i.gender === "Unisex").slice(0, 3).map(fmt),
    notes,
    instruction: "Show the pick with show_products. Explain in one or two sentences why it fits (their shoes, arch, ball-of-foot). Mention another version only if a note asks you to.",
  };
}
