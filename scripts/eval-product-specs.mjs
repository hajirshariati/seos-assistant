// Product specs (Catalog → Product specs): the Excel/CSV sheet is read
// exactly, every value cleaned to one wording, matched to products only by
// code (or the same style, confirmed), never copied where it could be wrong,
// and the product page always wins. Search filters only find what's listed.
//
// Run: node scripts/eval-product-specs.mjs
import assert from "node:assert/strict";
import zlib from "node:zlib";

const { readXlsx, XlsxError } = await import("../app/lib/xlsx-read.server.js");
const specs = await import("../app/lib/product-specs.js");
const { readSpecSheet, cleanSpecValue, headerKey, pageFacts, shopifySpecsCsv, cleanSheetCsv, specsReportCsv, tidyText } = specs;
const { parseCsv } = await import("../app/lib/csv.server.js");
const { buildLeanCatalog } = await import("../app/lib/lean/catalog.js");
const { leanSearch, productDetails, allMatches } = await import("../app/lib/lean/search.js");
const { buildLeanTools } = await import("../app/lib/lean/tools.js");
const { buildLeanSystemPrompt } = await import("../app/lib/lean/prompt.js");
const { cleanViewAllSearch } = await import("../app/lib/lean/shop-all.js");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}

// ── a tiny .xlsx writer, for test workbooks ──
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
    const data = zlib.deflateRawSync(raw);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const col = (i) => String.fromCharCode(65 + i);
// tabs: [{ name, hidden, rows: [[cell…]] }] — strings go to shared strings,
// numbers stay numbers; inline: true writes strings inline instead.
function xlsx(tabs, { inline = false } = {}) {
  const shared = [];
  const sid = (s) => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1; } return i; };
  const files = {};
  tabs.forEach((t, ti) => {
    const rows = t.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      if (v == null || v === "") return "";
      const ref = `${col(ci)}${ri + 1}`;
      if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
      return inline ? `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>` : `<c r="${ref}" t="s"><v>${sid(v)}</v></c>`;
    }).join("")}</row>`).join("");
    files[`xl/worksheets/sheet${ti + 1}.xml`] = `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
  });
  files["xl/workbook.xml"] = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${tabs.map((t, i) => `<sheet name="${esc(t.name)}" sheetId="${i + 1}"${t.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  files["xl/_rels/workbook.xml.rels"] = `<?xml version="1.0"?><Relationships>${tabs.map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`;
  files["xl/sharedStrings.xml"] = `<?xml version="1.0"?><sst>${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`;
  return zip(files);
}

// A sheet like the real one: tabs with their own headers and wording.
const HEAD_AP = ["Style #", "Style Name", "Description", "Color", "Removable Depth", "Shank", "Contains pig product.", "Upper", "Lining", "Outsole", "Heel height in mm", "Heel to toe offset", "Measurements for size 7W"];
const HEAD_BB = ["Style #", "Description", "Removable Depth", "Contains Pig Products", "Shank", "Upper", "Lining", "Midsole", "Outsole2", "Heel Heights", "Heel height in Inches", 'Heel to Toe offset "drop"', "Shaft Height if applicable", "Shaft Circumference if applicable", "Temperature Rating", "Slip Resistent "];
const WORKBOOK = [
  { name: "AP - M's W's ATHLETIC SHOE", rows: [HEAD_AP,
    ["AP100", "Danika", "Mesh lace-up", "Black", '5/16"in (8mm)', "None", "No", "Fabric", "Fabric", "EVA with Rubber pods", "28.8mm", "13.3mm"],
    ["AP101", "Danika", "Mesh lace-up", "White", '5/16"in (8mm)', "None", "Yes", "Fabric", "Fabric", "EVA with Rubber pods", "28.8mm", "13.3mm"],
    ["AP900", "Chase", "Mesh lace-up", "Black", '5/16"in (8mm)', "None", "No", "Fabric", "Fabric", "EVA with Rubber pods", "33mm", "15.3mm"],
    ["AP950M", "Dash", "Knit", "Black", '5/16"in (8mm)', "None", "No", "Fabric", "Fabric", "EVA with Rubber pods", "28.8mm", "13.3mm"]] },
  { name: "BB - Berries Boots", rows: [HEAD_BB,
    ["BB293 ", "Ivory furry boot", "3/16”", "NO", "N/A", "Leather/ Synthetic Fur", "Synthetic Fur", "Eva", "Rubber", "25mm", '1 1/8"', "15mm", "135", "320mm", "Up to -20C / -4F", "Yes"]] },
  { name: "AU - Aurora", rows: [["Style #", "Style Name", "Description", "Color", "Removable Depth", "Shank", "Contains pig product.", "Upper", "Lining", "Outsole", "Heel height in mm", "Toe height (mm)", "Heel to toe offset (mm)"],
    ["AU1100", "Kendall", "Flip Flop", "Black", "NA", "Yes, Metal", "No", "LEATHER", "FABRIC", " Rubber", 24.8, 17.2, 7.6000000000000014]] },
  { name: "SS - Sport Sandal", rows: [["47mm", "17mm", "Description", "Removable Depth", "Contains Pig Products", "Shank", "Upper", "Lining", "Outsole", "Actual Heel Height", 'Heel to Toe offset "drop"'],
    ["SS500", "MARZ", "Webbing sandal", "N ONE", "No", "Fiber Glass", "Seude", "Fabric", "Rubber", "47mm", "17mm"]] },
  { name: "Lynco", rows: [["Style #", "Description", "Removable Depth", "Contains Pig Products", "Upper", "Heel Heights"],
    ["L3000", "Black flip", "None", "No", "EVA", "34mm"],
    ["L3000W", "Black flip women", "None", "No", "EVA", "27.8mm"]] },
  { name: "Old styles", hidden: true, rows: [["Style #", "Style Name", "Removable Depth", "Contains Pig Products"], ["AP102", "Danika", "None", "Yes"]] },
  { name: "Sheet1", rows: [] },
];

const product = (handle, title, attributes = {}, productType = "Footwear") => ({
  handle, title, productType, status: "ACTIVE", tags: [], description: "",
  attributesJson: attributes,
  variants: [{ sku: "", price: "120.00", inventoryQty: 5, optionsJson: JSON.stringify([{ name: "Size", value: "8 US" }]) }],
});
const sheet = readSpecSheet(readXlsx(xlsx(WORKBOOK)));
const rowOf = (code) => sheet.rows.find((r) => r.code === code);

console.log("\nreading the workbook");
await test("every tab is read with its cells exactly — shared and inline strings, numbers, entities; blank cells skipped", () => {
  const tabs = readXlsx(xlsx([{ name: "A & B", rows: [["Style #", "Name"], ["X100", "Tom & Jerry <3"], ["", "  "], [12.5, ""]] }], { inline: true }));
  assert.equal(tabs[0].name, "A & B");
  assert.deepEqual(tabs[0].rows, [["Style #", "Name"], ["X100", "Tom & Jerry <3"], ["12.5"]]);
  const shared = readXlsx(xlsx(WORKBOOK));
  assert.equal(shared.length, WORKBOOK.length);
  assert.equal(shared[0].rows[1][4], '5/16"in (8mm)');
  assert.equal(shared.find((t) => t.name === "Old styles").hidden, true);
});
await test("not a workbook, or one that unpacks too large: refused with a plain message", () => {
  assert.throws(() => readXlsx(Buffer.from("name,code\nx,y")), XlsxError);
  const bomb = zip({ "xl/workbook.xml": Buffer.alloc(31 * 1024 * 1024, 32) });
  assert.throws(() => readXlsx(bomb), (e) => e instanceof XlsxError && /too large/.test(e.message));
});

console.log("\ncleaning the sheet");
await test("every header wording maps to its field (Style #, CROSS, pig product., Outsole2, drop, Slip Resistent…)", () => {
  const cases = { "Style #": "code", CROSS: "code", "STYLE NAME": "name", "Style Name2": "name", "Contains pig product.": "contains_pig_products", "Contains Pig Products ": "contains_pig_products",
    "Includes Met pad": "metatarsal_pad", "Contains metpad support": "metatarsal_pad", Outsole2: "outsole", "Heel Heights": "heel_mm", "Actual  Heel Heights": "heel_mm", "Heel height (mm)": "heel_mm",
    "Heel height in Inches": "heel_in", "Heel heights in.": "heel_in", 'Heel to Toe offset "drop"': "heel_to_toe_drop", "Heel to toe offset (mm)": "heel_to_toe_drop",
    "Shaft Height if applicable": "shaft_height", "Shaft Circumference if applicable": "shaft_circumference", "Temperature Rating": "temperature_rating", "Slip Resistent ": "slip_resistant",
    "MISC Comments": "notes", "Measurements for size 7W": "measurements", "Removable Depth": "removable_footbed_depth", "Color": "color", Program: "description", "47mm": null };
  for (const [h, k] of Object.entries(cases)) assert.equal(headerKey(h), k, h);
});
await test("one wording per value: None/NONE/N ONE, quotes, \"in\", mm spacing, float noise, capitals, typos", () => {
  assert.deepEqual(cleanSpecValue("removable_footbed_depth", "N ONE"), { value: "", removable: "No" });
  assert.deepEqual(cleanSpecValue("removable_footbed_depth", "NONE"), { value: "", removable: "No" });
  assert.deepEqual(cleanSpecValue("removable_footbed_depth", "3/16”"), { value: '3/16"', removable: "Yes" });
  assert.deepEqual(cleanSpecValue("removable_footbed_depth", '5/16"in (8mm)'), { value: '5/16" (8 mm)', removable: "Yes" });
  assert.deepEqual(cleanSpecValue("removable_footbed_depth", "N/A"), { unknown: true }, "not applicable is not 'no'");
  assert.deepEqual(cleanSpecValue("contains_pig_products", "YES"), { value: "Yes" });
  assert.deepEqual(cleanSpecValue("contains_pig_products", "-"), { unknown: true }, "a dash isn't a no");
  assert.deepEqual(cleanSpecValue("contains_pig_products", "maybe"), { odd: true });
  assert.equal(cleanSpecValue("shank", "Yes, Metal").value, "Metal");
  assert.equal(cleanSpecValue("shank", "Fiber Glass").value, "Fiberglass");
  assert.equal(cleanSpecValue("shank", "No").value, "None");
  assert.deepEqual(cleanSpecValue("shank", "N/A"), { unknown: true });
  assert.equal(cleanSpecValue("lining", "None").value, "Unlined");
  assert.equal(cleanSpecValue("upper", "Seude").value, "Suede");
  assert.equal(cleanSpecValue("upper", "LEATHER").value, "Leather");
  assert.equal(cleanSpecValue("outsole", "EVA and RUBBER").value, "EVA and Rubber");
  assert.equal(cleanSpecValue("outsole", "Eva and Rubber").value, "EVA and Rubber");
  assert.equal(cleanSpecValue("heel_to_toe_drop", "7.6000000000000014", "mm").value, "7.6 mm");
  assert.equal(cleanSpecValue("heel_mm", "27.50mm").value, '27.5 mm (1.1")');
  assert.equal(cleanSpecValue("shaft_height", '8 3/4"in').value, '8 3/4"');
  assert.equal(cleanSpecValue("shaft_height", "135").value, '135 mm (5.3")');
  assert.equal(cleanSpecValue("shaft_height", "6").value, '6"');
  assert.equal(cleanSpecValue("shaft_circumference", "362mm").value, '362 mm (14.3")');
  assert.equal(cleanSpecValue("temperature_rating", "Up to -20C / -4F").value, "Up to -20°C / -4°F");
  assert.equal(cleanSpecValue("shaft_height", '5 in"').value, '5"', "the unit written twice");
  assert.equal(cleanSpecValue("shaft_height", '4in"').value, '4"');
  assert.equal(cleanSpecValue("shaft_height", '5 1/2in"').value, '5 1/2"');
  assert.equal(cleanSpecValue("shaft_height", "6 inches").value, '6"');
  assert.equal(cleanSpecValue("heel_to_toe_drop", "46.mm").value, "46 mm");
  assert.equal(cleanSpecValue("heel_in", '1 3/20th"').value, '1 3/20"');
  assert.equal(cleanSpecValue("upper", "Fabric w/ leather").value, "Fabric with leather");
  assert.deepEqual(cleanSpecValue("heel_to_toe_drop", "245mm"), { odd: true }, "a drop that can't be real is never shown");
  assert.deepEqual(cleanSpecValue("shaft_circumference", "36mm"), { odd: true });
  assert.deepEqual(cleanSpecValue("heel_mm", "Flat"), { odd: true });
  assert.equal(cleanSpecValue("heel_to_toe_drop", "62mm").value, "62 mm", "a tall wedge's drop is fine");
  assert.equal(tidyText("1.125"), "1.125", "real precision stays");
  assert.equal(tidyText('Up to "X"'), 'Up to "X"');
});
await test("the workbook → one row per code: hidden and empty tabs skipped, a typed-over header still read, units added", () => {
  const skipped = Object.fromEntries(sheet.report.tabs.filter((t) => t.skipped).map((t) => [t.tab, t.skipped]));
  assert.match(skipped["Old styles"], /hidden/);
  assert.equal(skipped.Sheet1, "empty");
  assert.equal(rowOf("ap102"), undefined, "nothing from a hidden tab");
  assert.deepEqual(rowOf("ap100"), { code: "ap100", base: "ap100", gender: "", name: "Danika", tab: "AP - M's W's ATHLETIC SHOE",
    fields: { removable_footbed: "Yes", removable_footbed_depth: '5/16" (8 mm)', shank: "None", contains_pig_products: "No", upper: "Fabric", lining: "Fabric", outsole: "EVA with Rubber pods", heel_height: '28.8 mm (1.1")', heel_to_toe_drop: "13.3 mm" } });
  assert.deepEqual(rowOf("ap950m"), { ...rowOf("ap950m"), base: "ap950", gender: "m" });
  const bb = rowOf("bb293");
  assert.equal(bb.name, "", "no style name column");
  assert.equal(bb.fields.heel_height, '25 mm (1")', "the measured mm, inches worked out from it");
  assert.equal(bb.fields.shaft_height, '135 mm (5.3")');
  assert.equal(bb.fields.slip_resistant, "Yes");
  assert.equal(bb.fields.shank, undefined, "N/A → not listed");
  assert.equal(bb.fields.upper, "Leather / Synthetic Fur");
  const au = rowOf("au1100");
  assert.deepEqual([au.fields.removable_footbed, au.fields.shank, au.fields.upper, au.fields.heel_height, au.fields.toe_height, au.fields.heel_to_toe_drop],
    [undefined, "Metal", "Leather", '24.8 mm (1")', "17.2 mm", "7.6 mm"]);
  const ss = rowOf("ss500");
  assert.ok(ss, "the code column found though its header was typed over");
  assert.deepEqual([ss.fields.removable_footbed, ss.fields.shank, ss.fields.upper], ["No", "Fiberglass", "Suede"]);
  assert.deepEqual(Object.keys(sheet.report.ignored), ["Measurements for size 7W", "17mm"]);
  assert.equal(sheet.report.codes, 9);
});
await test("a code listed twice with different values is reported", () => {
  const twice = readSpecSheet([{ name: "A", rows: [["Style #", "Removable Depth", "Shank"], ["X100", "3/16\"", "Metal"]] }, { name: "B", rows: [["Style #", "Removable Depth", "Shank"], ["X100", "1/4\"", "Metal"]] }]);
  assert.deepEqual(twice.report.duplicates, [{ code: "x100", field: "removable_footbed_depth", values: ['3/16"', '1/4"'], tabs: ["A", "B"] }]);
});

console.log("\nmatching products");
const PAGE_YES = { comfort: "Adjustability: Laces; Removable Insole: Yes" };
const PAGE_NO = { comfort: "Removable Insole: No" };
const rows = [
  product("danika-black-ap100w", "Danika Arch Support Sneaker - Black", { ...PAGE_YES, measurements: "Heel Height: 1.2\"", materials: "Upper Material: Mesh" }),
  product("danika-ivory-ap111w", "Danika Arch Support Sneaker - Ivory", PAGE_YES),
  product("danika-pink-ap107w", "Danika Arch Support Sneaker - Pink", PAGE_YES),
  product("chase-mens-black-black-ap931m", "Chase Arch Support Sneaker - Black/Black", PAGE_YES),
  product("dash-mens-grey-ap956m", "Dash Arch Support Sneaker - Grey", PAGE_YES),
  product("dash-women-grey-ap956w", "Dash Arch Support Sneaker - Grey", PAGE_YES),
  product("jodie-fur-ivory-bb293w", "Jodie Fur Boot - Ivory", PAGE_YES),
  product("kendall-black-au1100w", "Kendall Flip Flop - Black", PAGE_NO),
  product("kendall-sage-au1107w", "Kendall Flip Flop - Sage", PAGE_YES),
  product("marz-beige-ss507w", "Marz Sport Sandal - Beige", PAGE_NO),
  product("maui-matte-black-l3000w", "Maui Flip - Matte Black", PAGE_NO),
  product("maui-black-l3000m", "Maui Flip - Black", PAGE_NO),
  product("athena-black-ct850w", "Athena Sneaker - Black", PAGE_YES),
  product("l2300m-m", "Compete Orthotics", {}, "Orthotics"),
];
const catalog = buildLeanCatalog(rows, { shop: "s.myshopify.com", specRows: sheet.rows });
const P = Object.fromEntries(catalog.products.map((p) => [p.handle, p]));
await test("by its exact code: every field the sheet has for it", () => {
  const d = P["danika-black-ap100w"];
  assert.equal(d.specs.removable_footbed_depth, '5/16" (8 mm)');
  assert.equal(d.specs.contains_pig_products, "No");
  assert.equal(d.specs.lining, "Fabric");
  assert.equal(d.specs.heel_to_toe_drop, "13.3 mm");
});
await test("the product page wins: its heel height and upper stay; the sheet only fills in what it doesn't say", () => {
  const d = P["danika-black-ap100w"];
  assert.equal(d.specs.heel_height, undefined);
  assert.equal(d.specs.upper, undefined);
  assert.equal(d.specFlags.removable_footbed, "Yes");
});
await test("a colorway not in the sheet gets its style's facts — only what's the same in every color, never pig products or materials", () => {
  const ivory = P["danika-ivory-ap111w"];
  assert.equal(ivory.specs.removable_footbed_depth, '5/16" (8 mm)');
  assert.equal(ivory.specs.contains_pig_products, undefined, "AP100 says No, AP101 Yes — and it's a color fact anyway");
  assert.equal(ivory.specs.lining, undefined);
  assert.equal(ivory.specs.upper, undefined);
  assert.equal(ivory.specs.heel_to_toe_drop, "13.3 mm");
  assert.equal(P["chase-mens-black-black-ap931m"].specs.heel_to_toe_drop, "15.3 mm", "AP931 → AP900: further apart, but the sheet names this style");
  assert.equal(catalog.specReport.styleOnly.some((s) => s.handle === "danika-ivory-ap111w"), true, "listed for the team to add");
});
await test("the men's or women's row when the sheet has one; a row for the other line never", () => {
  assert.equal(P["maui-matte-black-l3000w"].specs.contains_pig_products, "No");
  assert.equal(P["maui-matte-black-l3000w"].specs.heel_height, '27.8 mm (1.1")', "L3000W, not the men's L3000");
  assert.equal(P["maui-black-l3000m"].specs.heel_height, '34 mm (1.3")');
  assert.equal(P["dash-mens-grey-ap956m"].specs.heel_to_toe_drop, "13.3 mm", "AP956M → the men's AP950M");
  assert.deepEqual(P["dash-women-grey-ap956w"].specs, {}, "no women's Dash row, and the men's row is never used");
});
await test("a style the sheet doesn't have, or a code from another kind of product: nothing", () => {
  assert.deepEqual(P["athena-black-ct850w"].specs, {});
  assert.deepEqual(P["l2300m-m"].specs, {});
  assert.deepEqual(catalog.specReport.missing.map((m) => m.handle), ["dash-women-grey-ap956w", "athena-black-ct850w"]);
  assert.equal(catalog.specReport.products, 13, "the orthotic isn't counted against a shoe sheet");
});
await test("the sheet against the page: a contradiction is left out and reported; agreement keeps the depth", () => {
  const kendall = P["kendall-black-au1100w"];
  assert.equal(kendall.specs.removable_footbed, undefined, "N/A in the sheet → nothing");
  assert.equal(kendall.specFlags.removable_footbed, "No", "the page says No");
  const marz = P["marz-beige-ss507w"];
  assert.equal(marz.specs.removable_footbed, "No");
  const contra = buildLeanCatalog([product("jodie-fur-ivory-bb293w", "Jodie Fur Boot - Ivory", PAGE_NO)], { specRows: sheet.rows });
  assert.equal(contra.products[0].specs.removable_footbed, undefined);
  assert.equal(contra.products[0].specs.removable_footbed_depth, undefined);
  assert.equal(contra.products[0].specFlags.removable_footbed, "No");
  assert.deepEqual(contra.specReport.left, [{ handle: "jodie-fur-ivory-bb293w", title: "Jodie Fur Boot - Ivory", own: "bb293w", field: "removable_footbed", reason: "product page says otherwise", sheet: "Yes", page: "No" }]);
  // Boot measurements: the page's stay; a real difference is reported, rounding isn't.
  const boot = buildLeanCatalog([product("jodie-fur-ivory-bb293w", "Jodie Fur Boot - Ivory", { ...PAGE_YES, m: "Calf Height: 5.3\"; Calf Circumference: 30cm" })], { specRows: sheet.rows });
  assert.equal(boot.products[0].specs.shaft_height, undefined);
  assert.equal(boot.products[0].specs.shaft_circumference, undefined);
  assert.deepEqual(boot.specReport.left.map((l) => [l.field, l.sheet, l.page]), [["shaft_circumference", '320 mm (12.6")', "30cm"]]);
});
await test("a style name spelled differently in the sheet: no match, reported", () => {
  const typo = readSpecSheet([{ name: "BW", rows: [["Style #", "Style Name", "Removable Depth"], ["BW100", "Breanna", "None"]] }]);
  const c = buildLeanCatalog([product("brianna-taupe-bw102w", "Brianna Slip-On - Taupe", PAGE_NO)], { specRows: typo.rows });
  assert.deepEqual(c.products[0].specs, {});
  assert.deepEqual(c.specReport.nameMismatch.map((m) => [m.handle, m.sheetName]), [["brianna-taupe-bw102w", "Breanna"]]);
});
await test("the page's own words: \"Removable Insole(s): Yes/No/1/4\\\"\", heel height, materials, warmth rating", () => {
  assert.deepEqual(pageFacts({ c: "Removable Insoles: Yes; Warmth Rating: Up to -20 C/ -4 F", m: "Upper Material: Faux leather; Outsole Material: Rubber", h: "Heel Height: 1.1\"" }),
    { removable_footbed: "Yes", temperature_rating: "Up to -20 C/ -4 F", upper: "Faux leather", outsole: "Rubber", heel_height: '1.1"' });
  assert.deepEqual(pageFacts({ c: "Removable Insole: 1/4\"" }), { removable_footbed: "Yes" });
  assert.deepEqual(pageFacts({ m: "Mid-calf height boot; Heel Height : 1.25”; Calf Height: 5\"; Calf Circumference: 30cm", t: "Lining Material: Neoprene with plush faux fur" }),
    { heel_height: "1.25”", shaft_height: '5"', shaft_circumference: "30cm", lining: "Neoprene with plush faux fur" });
  assert.deepEqual(pageFacts({ c: "Removable Insole: None" }), { removable_footbed: "No" });
  assert.deepEqual(pageFacts({ c: "Padded collar for extra comfort" }), {});
  // Features named in the page's own words: a mention is a yes, a negation isn't.
  assert.deepEqual(pageFacts({ c: "Adjustability: Hook & loop closures; Met bar pod to help relieve ball-of-foot discomfort" }), { metatarsal_pad: "Yes" });
  assert.deepEqual(pageFacts({ c: "Metatarsal support to help reduce ball-of-foot discomfort; Slip-resistant outsole" }), { metatarsal_pad: "Yes", slip_resistant: "Yes" });
  assert.deepEqual(pageFacts({ c: "Not slip resistant on ice; Metal shank for stability" }), {});
});
await test("no sheet: products keep only what their pages say — nothing else changes", () => {
  const plain = buildLeanCatalog(rows, { shop: "s.myshopify.com" });
  assert.equal(plain.specReport, null);
  assert.deepEqual(plain.products.find((p) => p.handle === "danika-black-ap100w").specs, {});
  assert.equal(plain.products.find((p) => p.handle === "danika-black-ap100w").specFlags.removable_footbed, "Yes");
});

console.log("\nsearch and the assistant");
await test("spec filters find only products that list the spec — not knowing is never a yes", () => {
  const removable = allMatches(catalog, { query: "", removable_footbed: true }).map((p) => p.handle);
  assert.ok(removable.includes("danika-black-ap100w") && removable.includes("kendall-sage-au1107w"));
  assert.ok(!removable.includes("kendall-black-au1100w") && !removable.includes("l2300m-m"));
  const noPig = allMatches(catalog, { query: "", no_pig_products: true }).map((p) => p.handle).sort();
  // Marz's colorway (SS507) isn't in the sheet: its style row's "No" is a
  // color fact, so it's never copied.
  assert.deepEqual(noPig, ["danika-black-ap100w", "jodie-fur-ivory-bb293w", "kendall-black-au1100w", "maui-black-l3000m", "maui-matte-black-l3000w"]);
  assert.deepEqual(allMatches(catalog, { query: "", slip_resistant: true }).map((p) => p.handle), ["jodie-fur-ivory-bb293w"]);
  const none = leanSearch(catalog, { query: "", slip_resistant: true, no_pig_products: true, removable_footbed: false, categories: ["footwear"] });
  assert.equal(none.filters_applied.slip_resistant, true);
  assert.equal(none.filters_applied.removable_footbed, undefined, "false is no filter");
});
await test("a met pad or slip-resistant sole the page names counts for the filters; the sheet's \"No\" against it is left out and listed", () => {
  const c = buildLeanCatalog([
    product("jillian-black-sc450w", "Jillian Sandal - Black", { comfort: "Removable Insole: No; Met bar pod to help relieve ball-of-foot discomfort" }),
    product("charlotte-black-ca710w", "Charlotte Sneaker - Black", { comfort: "Removable Insole: Yes; Metatarsal support built in" }),
  ], { specRows: readSpecSheet([{ name: "CA", rows: [["Style #", "Style Name", "Removable Depth", "Includes Met pad"], ["CA710", "Charlotte", '3/16"', "No"]] }]).rows });
  assert.deepEqual(allMatches(c, { query: "", metatarsal_pad: true }).map((p) => p.handle).sort(), ["charlotte-black-ca710w", "jillian-black-sc450w"]);
  assert.deepEqual(c.specReport.left.map((l) => [l.handle, l.field, l.sheet, l.page]), [["charlotte-black-ca710w", "metatarsal_pad", "No", "Yes"]]);
  assert.equal(leanSearch(c, { query: "sandal" }).products[0].specs.metatarsal_pad, "Yes", "search results show it");
});
await test("a yes/no field is found by its name; a \"contains…\" one isn't", () => {
  assert.deepEqual(allMatches(catalog, { query: "slip resistant" }).map((p) => p.handle), ["jodie-fur-ivory-bb293w"]);
  assert.deepEqual(allMatches(catalog, { query: "pig" }), []);
});
await test("search results carry the specs a shopper decides on; full details carry all of them", () => {
  const r = leanSearch(catalog, { query: "boot", slip_resistant: true });
  assert.deepEqual(r.products[0].specs, { removable_footbed: "Yes", removable_footbed_depth: '3/16"', contains_pig_products: "No", temperature_rating: "Up to -20°C / -4°F", slip_resistant: "Yes" });
  const d = productDetails(catalog, "jodie-fur-ivory-bb293w");
  assert.equal(d.specs.shaft_circumference, '320 mm (12.6")');
  assert.equal(d.specs.lining, "Synthetic Fur");
  assert.equal(productDetails(catalog, "athena-black-ct850w").specs.removable_footbed, "Yes", "from its page");
});
await test("the filters are offered only when they'd find something; the prompt's spec rules come with them", () => {
  const props = buildLeanTools(catalog.vocab)[0].input_schema.properties;
  assert.ok(props.removable_footbed && props.no_pig_products && props.slip_resistant);
  assert.equal(props.metatarsal_pad, undefined, "no product lists one");
  const bare = buildLeanTools(buildLeanCatalog([product("a-x100w", "A - Black")]).vocab)[0].input_schema.properties;
  assert.ok(!("removable_footbed" in bare) && !("no_pig_products" in bare));
  const prompt = buildLeanSystemPrompt({ shop: "s", vocab: catalog.vocab });
  assert.match(prompt, /search with removable_footbed: true/);
  assert.match(prompt, /never call a product halal, kosher or vegan/);
  const plainPrompt = buildLeanSystemPrompt({ shop: "s", vocab: buildLeanCatalog([product("a-x100w", "A - Black")]).vocab });
  assert.doesNotMatch(plainPrompt, /removable_footbed|halal/);
});
await test("View all keeps the spec filters of the search behind it", () => {
  assert.deepEqual(cleanViewAllSearch({ query: "boots", removable_footbed: true, no_pig_products: "yes", slip_resistant: true }), { query: "boots", removable_footbed: true, slip_resistant: true });
});

console.log("\nfiles");
await test("for Shopify: the handle plus one metafield column per spec the pages don't already show, quoted correctly", () => {
  const byHandle = new Map(catalog.products.map((p) => [p.handle, { specs: p.specs }]));
  const csv = shopifySpecsCsv(catalog.products, byHandle);
  const { headers, rows: lines } = parseCsv(csv);
  assert.equal(headers[0], "Handle");
  assert.ok(headers.includes("Removable footbed depth (product.metafields.custom.removable_footbed_depth)"));
  assert.ok(headers.includes("Contains pig products (product.metafields.custom.contains_pig_products)"));
  assert.ok(!headers.some((h) => /\.(removable_footbed|heel_height|upper|outsole|midsole|notes)\)$/.test(h)), "never what product pages show");
  const jodie = lines.find((l) => l[0] === "jodie-fur-ivory-bb293w");
  assert.equal(jodie[headers.indexOf("Removable footbed depth (product.metafields.custom.removable_footbed_depth)")], '3/16"');
  assert.ok(!lines.some((l) => l[0] === "athena-black-ct850w" || l[0] === "l2300m-m"), "only products with specs");
});
await test("the cleaned sheet reads back to the very same specs", () => {
  const csv = cleanSheetCsv(sheet.rows);
  const { headers, rows: lines } = parseCsv(csv);
  const again = readSpecSheet([{ name: "cleaned", rows: [headers, ...lines] }]);
  assert.equal(again.rows.length, sheet.rows.length);
  for (const r of sheet.rows) assert.deepEqual(again.rows.find((x) => x.code === r.code).fields, r.fields, r.code);
});
await test("the to-check list names each product and the reason", () => {
  const csv = specsReportCsv({ sheet: sheet.report, match: catalog.specReport });
  assert.match(csv, /^Issue,Product,Handle/);
  assert.match(csv, /Not in the sheet,Athena Sneaker - Black,athena-black-ct850w/);
  assert.match(csv, /Colorway not in the sheet[^\n]*danika-ivory-ap111w,AP111W,,,,"Style rows used: AP100, AP101"/);
  assert.match(csv, /chase-mens-black-black-ap931m,AP931M,,,,Style row used: AP900/);
  assert.match(csv, /Not in the sheet,Athena Sneaker - Black,athena-black-ct850w,CT850W,/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
