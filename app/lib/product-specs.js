// Product specs — the store's technical sheet (an Excel workbook or a CSV,
// one row per style code: removable footbed, pig products, shank, lining,
// heel-to-toe drop, boot shaft, temperature rating…), cleaned up and matched
// to the store's products by code.
//
// Accuracy rules:
// - A product gets a row by its exact code, or — when its colorway isn't in
//   the sheet — by its style (same code but the last digit), and then only
//   the fields that are the same in every color of that style (never
//   materials or pig products, which can differ by color).
// - A sheet row that names a style only matches products of that style.
// - Rows for the same code that disagree on a field: that field is left out.
// - What the product page itself states wins: the sheet only fills in what
//   the page doesn't say, and a sheet value that contradicts the page is
//   left out. Every left-out value is listed in the report.
// Pure — the upload, storage and catalog wiring live in product-specs.server.js.

// The fields, in display order. color: can differ between the colors of a
// style, so it's never taken from another colorway's row. csv: false — not
// written to the Shopify CSV (product pages already show it: "Removable
// Insole", "Heel Height", "Upper Material"…, so a second value there could
// only disagree).
export const SPEC_FIELDS = [
  { key: "removable_footbed", label: "Removable footbed", csv: false },
  { key: "removable_footbed_depth", label: "Removable footbed depth" },
  { key: "contains_pig_products", label: "Contains pig products", color: true },
  { key: "upper", label: "Upper", color: true, csv: false },
  { key: "lining", label: "Lining", color: true },
  { key: "midsole", label: "Midsole", csv: false },
  { key: "outsole", label: "Outsole", csv: false },
  { key: "shank", label: "Shank" },
  { key: "heel_height", label: "Heel height", csv: false },
  { key: "heel_to_toe_drop", label: "Heel-to-toe drop" },
  { key: "toe_height", label: "Toe height" },
  { key: "shaft_height", label: "Shaft height" },
  { key: "shaft_circumference", label: "Shaft circumference" },
  { key: "temperature_rating", label: "Temperature rating" },
  { key: "slip_resistant", label: "Slip resistant" },
  { key: "metatarsal_pad", label: "Metatarsal pad" },
  { key: "notes", label: "Notes", color: true, csv: false },
];
export const SPEC_KEYS = SPEC_FIELDS.map((f) => f.key);
const FIELD = Object.fromEntries(SPEC_FIELDS.map((f) => [f.key, f]));

// The ones a shopper decides on — shown with search results; the rest come
// with a product's full details.
export const SEARCH_SPEC_KEYS = ["removable_footbed", "removable_footbed_depth", "contains_pig_products", "slip_resistant", "metatarsal_pad", "temperature_rating"];

// Spec filters for search: which products pass. null = not known — never passes.
export const SPEC_FILTERS = {
  removable_footbed: (f) => f.removable_footbed === "Yes",
  no_pig_products: (f) => f.contains_pig_products === "No",
  slip_resistant: (f) => f.slip_resistant === "Yes",
  metatarsal_pad: (f) => f.metatarsal_pad === "Yes",
};

// ── Reading the sheet ──────────────────────────────────────────────────────

export function normalizeHeader(h) {
  return String(h ?? "")
    .toLowerCase()
    .replace(/[“”"'’‘#.()]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/([a-z])\d$/, "$1"); // "Outsole2", "Style Name2" — a copied column
}

// Normalized header → field. heel_mm / heel_in are joined into heel_height.
const HEADERS = [
  [/^(style|style no|style number|style code|style id|cross|code|sku|item|item no|item number|article|article number)$/, "code"],
  [/^(style name|name|product name)$/, "name"],
  [/^(description|program|style description)$/, "description"],
  [/^(color|colour|color name)$/, "color"],
  [/^removable( footbed| insole)?( depth)?$/, "removable_footbed_depth"],
  [/^(contains )?pig products?$/, "contains_pig_products"],
  [/^(includes |contains |has )?(met ?pad|metatarsal pad)( support)?$/, "metatarsal_pad"],
  [/^(has a )?shank$/, "shank"],
  [/^upper( material)?$/, "upper"],
  [/^lining( material)?$/, "lining"],
  [/^outsole( material)?$/, "outsole"],
  [/^midsole( material)?$/, "midsole"],
  [/^(actual )?heel heights?( in)? (inches|in)$/, "heel_in"],
  [/^(actual )?heel heights?( in)?( mm)?$/, "heel_mm"],
  [/^(heel to toe (offset|drop)|drop)( drop)?( in)?( mm)?$/, "heel_to_toe_drop"],
  [/^toe height( in)?( mm)?$/, "toe_height"],
  [/^shaft height( if applicable| in inches| in)?$/, "shaft_height"],
  [/^shaft circumference( if applicable)?( mm| in)?$/, "shaft_circumference"],
  [/^(temperature|temp|warmth) rating$/, "temperature_rating"],
  [/^slip resist[ae]n(t|ce)$/, "slip_resistant"],
  [/^(misc comments|misc comment|comments|notes|note|misc)$/, "notes"],
  [/^measurements?( for size.*)?$/, "measurements"],
];
export function headerKey(h) {
  const n = normalizeHeader(h);
  if (!n) return null;
  for (const [re, key] of HEADERS) if (re.test(n)) return key;
  return null;
}
const unitOf = (h) => {
  const n = normalizeHeader(h);
  return /\bmm\b/.test(n) ? "mm" : /\b(inches|in)$/.test(n) ? "in" : "";
};

// A style code: letters then digits ("AP100", "L5000W", "BB330").
const CODE_RE = /^[a-z]{1,4}\d{2,}[a-z]?$/;
const cleanCode = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
// "ap950m" → { base: "ap950", gender: "m" }: a trailing m/w is the line.
export function splitCode(code) {
  const c = cleanCode(code);
  const m = c.match(/^([a-z]{1,4}\d{2,})([a-z]?)$/);
  if (!m) return null;
  return { code: c, base: m[1], gender: m[2] === "m" || m[2] === "w" ? m[2] : "" , suffix: m[2] };
}

// ── Cleaning values ────────────────────────────────────────────────────────

const ACRONYMS = new Set(["EVA", "PU", "TPU", "TPR", "TR", "PVC", "TPE"]);
const isNoneish = (s) => /^(none|no|nil|n|0|unlined|notremovable)$/i.test(s.replace(/\s+/g, ""));
const isUnknown = (s) => /^(n\/?a|na|notapplicable|tbd|tbc|\?+|-+|unknown|n\.a\.?)$/i.test(s.replace(/\s+/g, "")) || s === "";
const isYes = (s) => /^(yes|y|true|x|✓|✔)$/i.test(s.replace(/\s+/g, ""));

function tidyNumber(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return String(Math.round(x * 100) / 100);
}

// Shared clean-up: one kind of quote, no "in" after an inch mark, "29mm" →
// "29 mm", float noise rounded, shouty capitals calmed, slashes spaced.
export function tidyText(raw) {
  let s = String(raw ?? "")
    .replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'")
    .replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.replace(/"\s*in\b\.?/gi, '"').replace(/(\d)\s+"/g, '$1"');
  // Spreadsheet float noise ("7.6000000000000014"), not real precision.
  s = s.replace(/(\d+\.\d{6,})/g, (m) => tidyNumber(m));
  s = s.replace(/(\d+)\.(\d*?)0+(?=\D|$)/g, (m, a, b) => (b ? `${a}.${b}` : a));
  s = s.replace(/(\d)\s*mm\b/gi, "$1 mm");
  s = s.replace(/([a-z)])\s*\/\s*([a-z(])/gi, "$1 / $2");
  s = s.replace(/\bseude\b/gi, (m) => (m[0] === "S" ? "Suede" : "suede")).replace(/\bfiber glass\b/gi, "Fiberglass");
  const letters = s.replace(/[^a-z]/gi, "");
  if (letters.length > 4 && letters === letters.toUpperCase()) {
    s = s.toLowerCase().replace(/\b[a-z][a-z']*/g, (w) => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  } else if (s === s.toLowerCase()) {
    s = s.replace(/\b[a-z][a-z']*/g, (w) => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w));
    s = s[0].toUpperCase() + s.slice(1);
  } else {
    // "EVA and RUBBER": a shouted word inside mixed text.
    s = s.replace(/\b[A-Z]{5,}\b/g, (w) => w[0] + w.slice(1).toLowerCase());
  }
  return s.replace(/\b(eva|tpu|tpr)\b/gi, (w) => w.toUpperCase());
}

const MM_PER_IN = 25.4;
const toInches = (mm) => `${Math.round((mm / MM_PER_IN) * 10) / 10}"`;
const bareNumber = (s) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);

// A measurement: a bare number gets its unit from the column ("Heel height
// in mm") or the field; mm gets its inches alongside, for US shoppers.
function measurement(raw, unit, fallbackUnit, { inches = true } = {}) {
  const s = tidyText(raw);
  if (isUnknown(s) || isNoneish(s)) return "";
  const n = bareNumber(s);
  let out = s;
  if (n != null) {
    const u = unit || fallbackUnit(n);
    out = u === "in" ? `${tidyNumber(n)}"` : `${tidyNumber(n)} mm`;
  }
  const mm = out.match(/^(-?\d+(?:\.\d+)?) mm$/);
  return mm && inches ? `${out} (${toInches(Number(mm[1]))})` : out;
}

// raw cell → { value } | { unknown: true } | { odd: true } for one field.
export function cleanSpecValue(key, raw, unit = "") {
  const s = tidyText(raw);
  if (isUnknown(s)) return { unknown: true };
  switch (key) {
    case "contains_pig_products":
    case "slip_resistant":
    case "metatarsal_pad":
      if (isYes(s)) return { value: "Yes" };
      if (isNoneish(s)) return { value: "No" };
      return { odd: true };
    case "removable_footbed_depth":
      if (isNoneish(s)) return { value: "", removable: "No" };
      if (isYes(s)) return { value: "", removable: "Yes" };
      if (/\d/.test(s)) return { value: measurement(raw, unit, () => "in", { inches: false }), removable: "Yes" };
      return { odd: true };
    case "shank": {
      if (isNoneish(s)) return { value: "None" };
      const t = s.replace(/^yes\s*[,:-]\s*/i, "");
      return { value: t[0].toUpperCase() + t.slice(1) };
    }
    case "lining":
      if (isNoneish(s)) return { value: "Unlined" };
      return { value: s };
    case "heel_mm":
    case "toe_height":
    case "heel_to_toe_drop": {
      const v = measurement(raw, unit, () => "mm", { inches: key === "heel_mm" });
      return v ? { value: v } : { unknown: true };
    }
    case "heel_in": {
      const v = measurement(raw, unit || "in", () => "in");
      return v ? { value: v } : { unknown: true };
    }
    case "shaft_height": {
      const v = measurement(raw, unit, (n) => (n <= 30 ? "in" : "mm"));
      return v ? { value: v } : { unknown: true };
    }
    case "shaft_circumference": {
      const v = measurement(raw, unit, (n) => (n > 100 ? "mm" : "in"));
      return v ? { value: v } : { unknown: true };
    }
    case "temperature_rating":
      if (isNoneish(s)) return { unknown: true };
      return { value: s.replace(/(-?\d+)\s*°?\s*([CF])\b/g, "$1°$2") };
    default:
      if (isNoneish(s) && key !== "notes") return { unknown: true };
      return { value: s };
  }
}

// Where the header row is: the first of the top rows that names at least
// three known fields.
function headerRowOf(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const keys = (rows[i] || []).map(headerKey).filter((k) => k && k !== "measurements");
    if (new Set(keys).size >= 3) return i;
  }
  return -1;
}

const codeShare = (rows, col) => {
  const vals = rows.map((r) => String(r[col] ?? "").trim()).filter(Boolean);
  return vals.length ? vals.filter((v) => CODE_RE.test(cleanCode(v))).length / vals.length : 0;
};

// tabs: [{ name, hidden, rows }] (readXlsx, or one CSV as one tab) →
// { rows: [{ code, base, gender, name, tab, fields }], report }.
export function readSpecSheet(tabs = []) {
  const out = [];
  const report = { tabs: [], columns: {}, ignored: {}, odd: [], rowsRead: 0 };
  for (const tab of tabs) {
    const rows = Array.isArray(tab?.rows) ? tab.rows : [];
    const name = String(tab?.name || "Sheet").trim();
    // Hidden in Excel usually means set aside (old styles, drafts).
    if (tab?.hidden) { report.tabs.push({ tab: name, rows: 0, skipped: "hidden in Excel — unhide it to use it" }); continue; }
    const h = headerRowOf(rows);
    if (h < 0) { report.tabs.push({ tab: name, rows: 0, skipped: rows.length ? "no recognizable columns" : "empty" }); continue; }
    const header = rows[h];
    const body = rows.slice(h + 1);
    const cols = header.map((x) => ({ raw: String(x ?? "").trim(), key: headerKey(x), unit: unitOf(x) }));
    let codeCol = cols.findIndex((c) => c.key === "code");
    // A header row typed over ("47mm" where "Style #" should be): the
    // column that holds codes is the code column.
    if (codeCol < 0 || codeShare(body, codeCol) < 0.5) {
      const width = Math.max(0, ...body.map((r) => r.length));
      const found = Array.from({ length: width }, (_, i) => i).find((i) => codeShare(body, i) >= 0.6);
      if (found == null) { report.tabs.push({ tab: name, rows: 0, skipped: "no style code column" }); continue; }
      if (codeCol >= 0) cols[codeCol] = { ...cols[codeCol], key: null };
      codeCol = found;
      cols[codeCol] = { ...cols[codeCol], key: "code" };
    }
    const nameCol = cols.findIndex((c) => c.key === "name");
    for (const c of cols) {
      if (!c.raw) continue;
      if (c.key && !["code", "name", "description", "color", "measurements"].includes(c.key)) report.columns[c.raw] = c.key;
      else if (!c.key || c.key === "measurements") report.ignored[c.raw] = (report.ignored[c.raw] || 0) + 1;
    }
    let read = 0;
    for (const row of body) {
      const codes = String(row[codeCol] ?? "").split(/[/,;&]|\s{2,}|\s+and\s+/i).map(splitCode).filter(Boolean)
        .filter((c) => CODE_RE.test(c.code));
      if (!codes.length) continue;
      const fields = {};
      let heelMm = "", heelIn = "";
      cols.forEach((c, i) => {
        if (!c.key || ["code", "name", "description", "color", "measurements"].includes(c.key)) return;
        const raw = row[i];
        if (raw == null || String(raw).trim() === "") return;
        const r = cleanSpecValue(c.key, raw, c.unit);
        if (r.odd) { if (report.odd.length < 200) report.odd.push({ tab: name, code: String(row[codeCol]).trim(), column: c.raw, value: String(raw).trim() }); return; }
        if (r.unknown) return;
        if (c.key === "heel_mm") { if (!heelMm) heelMm = r.value; return; }
        if (c.key === "heel_in") { if (!heelIn) heelIn = r.value; return; }
        if (c.key === "removable_footbed_depth") {
          if (fields.removable_footbed == null) fields.removable_footbed = r.removable;
          if (r.value && !fields.removable_footbed_depth) fields.removable_footbed_depth = r.value;
          return;
        }
        if (r.value && fields[c.key] == null) fields[c.key] = r.value;
      });
      // One heel height: the measured millimetres (with inches worked out
      // from them — a sheet's own inch column doesn't always agree), else
      // the inches given.
      if (heelMm || heelIn) fields.heel_height = heelMm || heelIn;
      const styleName = nameCol >= 0 ? tidyText(row[nameCol]) : "";
      for (const c of codes) {
        out.push({ code: c.code, base: c.base, gender: c.gender, name: styleName, tab: name, fields });
      }
      read++;
    }
    report.tabs.push({ tab: name, rows: read });
    report.rowsRead += read;
  }
  report.codes = new Set(out.map((r) => r.code)).size;
  report.duplicates = sheetDuplicates(out);
  return { rows: out, report };
}

// Codes listed more than once with different values for a field.
function sheetDuplicates(rows) {
  const byCode = new Map();
  for (const r of rows) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }
  const out = [];
  for (const [code, list] of byCode) {
    if (list.length < 2) continue;
    for (const key of SPEC_KEYS) {
      const vals = [...new Set(list.map((r) => r.fields[key]).filter(Boolean))];
      if (vals.length > 1) out.push({ code, field: key, values: vals, tabs: [...new Set(list.map((r) => r.tab))] });
    }
  }
  return out;
}

// ── What the product page already says ─────────────────────────────────────

// "Removable Insole: Yes", "Heel Height: 1.3\"", "Upper Material: Mesh" in
// the product's own fields → { removable_footbed: "Yes", heel_height: … }.
const PAGE_LABELS = [
  [/^removable (insoles?|footbeds?|inner soles?)$/i, "removable_footbed"],
  [/^heel height$/i, "heel_height"],
  [/^upper( material)?$/i, "upper"],
  [/^outsole( material)?$/i, "outsole"],
  [/^midsole( material)?$/i, "midsole"],
  [/^lining( material)?$/i, "lining"],
  [/^shank$/i, "shank"],
  [/^(shaft|calf|boot shaft) height$/i, "shaft_height"],
  [/^(shaft|calf|boot shaft|ankle) circumference$/i, "shaft_circumference"],
  [/^(warmth|temperature) rating$/i, "temperature_rating"],
  [/^contains pig products?$/i, "contains_pig_products"],
];
export function pageFacts(attributes = {}) {
  const out = {};
  for (const text of Object.values(attributes || {})) {
    for (const bit of String(text).split(/\s*;\s*|\n+/)) {
      const m = bit.match(/^\s*([A-Za-z][A-Za-z ]{2,40}?)\s*:\s*(.{1,80})$/);
      if (!m) continue;
      const hit = PAGE_LABELS.find(([re]) => re.test(m[1].trim()));
      if (!hit || out[hit[1]] != null) continue;
      const v = m[2].trim().replace(/[.;]+$/, "");
      if (hit[1] === "removable_footbed") {
        if (isYes(v) || /\d/.test(v)) out.removable_footbed = "Yes";
        else if (isNoneish(v)) out.removable_footbed = "No";
      } else if (hit[1] === "contains_pig_products") {
        if (isYes(v)) out.contains_pig_products = "Yes";
        else if (isNoneish(v)) out.contains_pig_products = "No";
      } else if (v) out[hit[1]] = v;
    }
  }
  return out;
}

// "1.3\"" / "29 mm (1.1\")" / "30cm" → inches, for comparing measurements.
function inchesOf(v) {
  const s = String(v || "").replace(/[”″]/g, '"');
  const mm = s.match(/(-?\d+(?:\.\d+)?)\s*mm\b/i);
  if (mm) return Number(mm[1]) / MM_PER_IN;
  const cm = s.match(/(-?\d+(?:\.\d+)?)\s*cm\b/i);
  if (cm) return (Number(cm[1]) * 10) / MM_PER_IN;
  const frac = s.match(/(\d+)\s+(\d+)\/(\d+)\s*"/) || s.match(/^(\d+)\/(\d+)\s*"/);
  if (frac) return frac.length === 4 ? Number(frac[1]) + Number(frac[2]) / Number(frac[3]) : Number(frac[1]) / Number(frac[2]);
  const n = s.match(/(\d+(?:\.\d+)?)\s*"/);
  return n ? Number(n[1]) : NaN;
}

// ── Matching products ──────────────────────────────────────────────────────

const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

// A sheet row's style name ("Jillian Sport") is in the product's title or handle.
function sameStyle(row, p) {
  if (!row.name) return true;
  const have = new Set([...words(p.title), ...words(p.handle)]);
  const want = words(row.name);
  return want.length > 0 && want.every((w) => have.has(w));
}

// The product's own codes as { base, gender } — from its handle and SKUs.
function productKeys(p) {
  const keys = [];
  for (const c of p.codes || []) {
    const k = splitCode(c);
    if (k && CODE_RE.test(k.code) && (k.suffix === "" || k.gender)) keys.push(k);
  }
  const gendered = keys.filter((k) => k.gender);
  const gender = gendered[0]?.gender || "";
  const bases = [...new Set((gendered.length ? gendered : keys).map((k) => k.base))];
  return { gender, bases };
}

// Rows for the product's line: the men's or women's row ("L3000W") when the
// sheet has one, else the rows that name no line ("L3000").
function forLine(rows, g) {
  if (!g) return rows;
  const own = rows.filter((r) => r.gender === g);
  return own.length ? own : rows.filter((r) => !r.gender);
}
const digits = (base) => (base.match(/\d+/)?.[0] || "").length;

// The fields every row agrees on; disagreements are dropped and reported.
function agree(rows, { colorToo }) {
  const fields = {};
  const conflicts = [];
  for (const key of SPEC_KEYS) {
    if (!colorToo && FIELD[key].color) continue;
    const vals = [...new Map(rows.map((r) => r.fields[key]).filter(Boolean).map((v) => [v.toLowerCase(), v])).values()];
    if (vals.length === 1) fields[key] = vals[0];
    else if (vals.length > 1) conflicts.push({ field: key, values: vals });
  }
  // A depth that disagrees takes nothing else with it; a removable flag that
  // disagrees takes its depth.
  if (!fields.removable_footbed) delete fields.removable_footbed_depth;
  if (fields.removable_footbed === "No") delete fields.removable_footbed_depth;
  return { fields, conflicts };
}

const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };

// byBase: the exact code. byStyle: the code but its last digit ("ap10" —
// AP100…AP109). byLine: the code but its last two ("ap1" — AP100…AP199),
// used only with the style's name confirmed.
export function indexSpecRows(rows = []) {
  const byBase = new Map();
  const byStyle = new Map();
  const byLine = new Map();
  for (const r of rows) {
    if (!r?.base) continue;
    push(byBase, r.base, r);
    if (digits(r.base) >= 3) {
      push(byStyle, r.base.slice(0, -1), r);
      if (r.name) push(byLine, r.base.slice(0, -2), r);
    }
  }
  return { byBase, byStyle, byLine, size: rows.length };
}

// One product → { specs, flags, match, codes } plus what was left out.
//   specs: the sheet's facts the page doesn't already state (shown to Claude)
//   flags: removable footbed / pig products / slip resistant / met pad as
//          known from the page or the sheet (search filters read these)
export function specsForProduct(p, index) {
  const page = pageFacts(p.attributes);
  const out = { specs: {}, flags: {}, match: null, codes: [], left: [], nameMismatch: null };
  for (const key of ["removable_footbed", "contains_pig_products"]) if (page[key]) out.flags[key] = page[key];
  if (!index?.size) return out;
  const { gender, bases } = productKeys(p);
  let rows = [];
  let kind = null;
  for (const base of bases) {
    const exact = forLine(index.byBase.get(base) || [], gender);
    if (exact.length) {
      const same = exact.filter((r) => sameStyle(r, p));
      if (!same.length) { out.nameMismatch = { code: exact[0].code, sheetName: exact[0].name }; continue; }
      rows = same; kind = "code"; break;
    }
  }
  if (!kind && !out.nameMismatch) {
    let otherName = null;
    for (const base of bases) {
      if (digits(base) < 3) continue;
      const fam = (index.byStyle.get(base.slice(0, -1)) || []).filter((r) => r.base.length === base.length);
      // Named rows must be this style; a family with other styles' names
      // in it is ambiguous for its unnamed rows.
      const named = forLine(fam.filter((r) => r.name && sameStyle(r, p)), gender);
      const usable = named.length ? named : fam.length && fam.every((r) => !r.name) ? forLine(fam, gender) : [];
      if (usable.length) { rows = usable; kind = "style"; break; }
      // Colorways further apart in number (Danika AP100 … AP118): only rows
      // that name this very style.
      const line = (index.byLine.get(base.slice(0, -2)) || []).filter((r) => r.base.length === base.length);
      const lineNamed = forLine(line.filter((r) => sameStyle(r, p)), gender);
      if (lineNamed.length) { rows = lineNamed; kind = "style"; break; }
      // The style's rows are there but name another style: likely a spelling.
      if (!otherName && fam.some((r) => r.name) && !fam.some((r) => r.name && sameStyle(r, p))) otherName = fam.find((r) => r.name);
    }
    if (!kind && otherName) out.nameMismatch = { code: otherName.code, sheetName: otherName.name };
  }
  if (!kind) return out;
  const { fields, conflicts } = agree(rows, { colorToo: kind === "code" });
  for (const c of conflicts) out.left.push({ field: c.field, reason: "sheet rows disagree", sheet: c.values.join(" | ") });
  // The page wins.
  for (const key of Object.keys(fields)) {
    if (page[key] == null) continue;
    if (key === "removable_footbed") {
      if (page[key] !== fields[key]) {
        out.left.push({ field: key, reason: "product page says otherwise", sheet: fields[key], page: page[key] });
        delete fields.removable_footbed; delete fields.removable_footbed_depth;
      }
      continue;
    }
    if (key === "heel_height" || key === "shaft_height" || key === "shaft_circumference") {
      const a = inchesOf(page[key]), b = inchesOf(fields[key]);
      if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > (key === "heel_height" ? 0.2 : 0.3)) {
        out.left.push({ field: key, reason: "product page says otherwise", sheet: fields[key], page: page[key] });
      }
    } else if (key === "contains_pig_products" && page[key] !== fields[key]) {
      out.left.push({ field: key, reason: "product page says otherwise", sheet: fields[key], page: page[key] });
    }
    delete fields[key];
  }
  out.specs = fields;
  out.match = kind;
  out.codes = [...new Set(rows.map((r) => r.code))];
  for (const key of ["removable_footbed", "contains_pig_products", "slip_resistant", "metatarsal_pad"]) {
    if (out.flags[key] == null && fields[key]) out.flags[key] = fields[key];
  }
  return out;
}

// Every product → its specs, plus the report the Catalog page shows. The
// report counts the kinds of products the sheet covers (a shoe sheet's
// coverage leaves orthotics out): the product types it matched.
export function applySpecs(products = [], rows = []) {
  const index = indexSpecRows(rows);
  const byHandle = new Map();
  const report = { products: 0, byCode: 0, byStyle: 0, missing: [], nameMismatch: [], styleOnly: [], left: [] };
  for (const p of products) byHandle.set(p.handle, specsForProduct(p, index));
  if (!index.size) return { byHandle, report };
  const typeOf = (p) => String(p.productType || "").trim().toLowerCase();
  // The product's own code ("AP111W"), so the team knows which row to add.
  const ownCode = (p) => {
    const keys = (p.codes || []).map(splitCode).filter((k) => k && CODE_RE.test(k.code));
    return (keys.find((k) => k.gender) || keys.find((k) => !k.suffix) || keys[0])?.code || "";
  };
  const covered = new Set(products.filter((p) => byHandle.get(p.handle).match || byHandle.get(p.handle).nameMismatch).map(typeOf));
  for (const p of products) {
    const r = byHandle.get(p.handle);
    // Nothing matched at all: every product counts, so the page says so.
    if (covered.size && !covered.has(typeOf(p))) continue;
    report.products++;
    if (r.match === "code") report.byCode++;
    else if (r.match === "style") { report.byStyle++; report.styleOnly.push({ handle: p.handle, title: p.title, own: ownCode(p), codes: r.codes }); }
    else if (r.nameMismatch) report.nameMismatch.push({ handle: p.handle, title: p.title, own: ownCode(p), ...r.nameMismatch });
    else report.missing.push({ handle: p.handle, title: p.title, own: ownCode(p) });
    for (const l of r.left) report.left.push({ handle: p.handle, title: p.title, own: ownCode(p), ...l });
  }
  return { byHandle, report };
}

// ── Files to download ──────────────────────────────────────────────────────

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (cells) => cells.map(csvCell).join(",");

// For Shopify's product import (Products → Import, "Overwrite products with
// matching handles"): the handle plus one column per spec metafield. Only
// what the product pages don't already state.
export function shopifySpecsCsv(products = [], byHandle = new Map(), { namespace = "custom" } = {}) {
  const rows = products
    .map((p) => ({ p, specs: byHandle.get(p.handle)?.specs || {} }))
    .filter((x) => Object.keys(x.specs).some((k) => FIELD[k]?.csv !== false));
  const keys = SPEC_FIELDS.filter((f) => f.csv !== false && rows.some((x) => x.specs[f.key])).map((f) => f.key);
  const header = ["Handle", ...keys.map((k) => `${FIELD[k].label} (product.metafields.${namespace}.${k})`)];
  return [csvLine(header), ...rows.map(({ p, specs }) => csvLine([p.handle, ...keys.map((k) => specs[k] || "")]))].join("\r\n") + "\r\n";
}

// The cleaned sheet: one row per code, every field in one wording.
export function cleanSheetCsv(rows = []) {
  const header = ["Tab", "Style #", "Style name", ...SPEC_FIELDS.map((f) => f.label)];
  return [csvLine(header), ...rows.map((r) => csvLine([r.tab, r.code.toUpperCase(), r.name, ...SPEC_KEYS.map((k) => r.fields[k] || "")]))].join("\r\n") + "\r\n";
}

// What needs a look, one line each: products the sheet doesn't cover, codes
// whose style name differs, values left out and why, cells not understood.
export function specsReportCsv({ sheet = {}, match = {} } = {}) {
  const up = (s) => String(s || "").toUpperCase();
  const lines = [csvLine(["Issue", "Product", "Handle", "Style #", "Field", "Sheet says", "Product page says", "Tab / note"])];
  for (const m of match.missing || []) lines.push(csvLine(["Not in the sheet", m.title, m.handle, up(m.own), "", "", "", ""]));
  for (const m of match.nameMismatch || []) lines.push(csvLine(["Style name in the sheet differs", m.title, m.handle, up(m.own), "Style name", m.sheetName, "", `Sheet row ${up(m.code)}`]));
  for (const l of match.left || []) lines.push(csvLine([l.reason === "product page says otherwise" ? "Sheet and product page disagree" : "Sheet lists the style twice with different values", l.title, l.handle, up(l.own), FIELD[l.field]?.label || l.field, l.sheet || "", l.page || "", ""]));
  for (const m of match.styleOnly || []) lines.push(csvLine(["Colorway not in the sheet — its style's specs are used; pig products and materials stay unknown", m.title, m.handle, up(m.own), "", "", "", `Style row${(m.codes || []).length > 1 ? "s" : ""} used: ${(m.codes || []).map(up).join(", ")}`]));
  for (const d of sheet.duplicates || []) lines.push(csvLine(["Code listed twice with different values", "", "", d.code.toUpperCase(), FIELD[d.field]?.label || d.field, d.values.join(" | "), "", d.tabs.join(" | ")]));
  for (const o of sheet.odd || []) lines.push(csvLine(["Value not understood", "", "", o.code, o.column, o.value, "", o.tab]));
  return lines.join("\r\n") + "\r\n";
}
