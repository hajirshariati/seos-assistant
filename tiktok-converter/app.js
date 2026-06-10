/* =========================================================================
   TikTok Seller export  ->  ERP pipe-delimited CSV
   Runs 100% in the browser. No data leaves the machine.
   ========================================================================= */

// ---- US state name -> 2-letter abbreviation ------------------------------
const STATE_ABBR = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
  "colorado":"CO","connecticut":"CT","delaware":"DE","district of columbia":"DC",
  "florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID","illinois":"IL",
  "indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
  "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN",
  "mississippi":"MS","missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY",
  "north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK","oregon":"OR",
  "pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  "tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT","virginia":"VA",
  "washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY",
  "puerto rico":"PR","guam":"GU","american samoa":"AS","virgin islands":"VI",
  "u.s. virgin islands":"VI","northern mariana islands":"MP","armed forces americas":"AA",
  "armed forces europe":"AE","armed forces pacific":"AP"
};

// ---- Country name -> ISO-2 ------------------------------------------------
const COUNTRY_ABBR = {
  "united states":"US","united states of america":"US","usa":"US","us":"US",
  "canada":"CA","united kingdom":"GB","uk":"GB"
};

// ---- The output columns, in exact order, with how each is produced -------
// ctx = { cfg, row } where row is the trimmed source record.
const COLUMNS = [
  ["Order Name",                   c => c.cfg.orderPrefix + g(c.row,"Order ID")],
  ["Order Status",                 c => c.cfg.orderStatus],
  ["Order Date",                   c => c.cfg.orderDate || formatDate(g(c.row,"Created Time"))],
  ["Total tax",                    c => money(g(c.row,"Taxes"))],
  ["Shipping Cost (ex tax)",       c => money(g(c.row,"Shipping Fee After Discount"))],
  ["Order Total",                  c => money(g(c.row,"Order Amount"))],
  ["Customer ID",                  c => ""],
  ["Customer Name",                c => g(c.row,"Recipient")],
  ["Customer Email",               c => c.cfg.email],
  ["Customer Phone",               c => cleanPhone(g(c.row,"Phone #"))],
  ["Ship Method",                  c => c.cfg.shipMethod],
  ["Payment Method",               c => c.cfg.paymentMethod],
  ["Total Shipped",                c => ""],
  ["Order Notes",                  c => ""],
  ["Customer Message",             c => g(c.row,"Buyer Message")],
  ["Shipping Name",                c => g(c.row,"Recipient")],
  ["Shipping First Name",          c => firstName(g(c.row,"Recipient"))],
  ["Shipping Last Name",           c => lastName(g(c.row,"Recipient"))],
  ["Shipping Company",             c => ""],
  ["Shipping Street 1",            c => g(c.row,"Address Line 1")],
  ["Shipping Street 2",            c => g(c.row,"Address Line 2")],
  ["Shipping Suburb",              c => g(c.row,"City")],
  ["Shipping State",               c => g(c.row,"State")],
  ["Shipping State Abbreviations", c => stateAbbr(g(c.row,"State"))],
  ["Shipping Zip",                 c => g(c.row,"Zipcode")],
  ["Shipping Country",             c => countryAbbr(g(c.row,"Country"))],
  ["Shipping Phone",               c => cleanPhone(g(c.row,"Phone #"))],
  ["Shipping Email",               c => c.cfg.email],
  ["Product ID",                   c => ""],
  ["Product Qty",                  c => g(c.row,"Quantity")],
  ["Product SKU",                  c => g(c.row,"Seller SKU")],
  ["Product Name",                 c => productName(c)],
  ["Product Unit Price",           c => perUnit(g(c.row,"SKU Subtotal After Discount"), g(c.row,"Quantity"))],
  ["Coupon Label",                 c => ""],
  ["Coupon",                       c => ""],
  ["Total Discount Amount",        c => ""],
  ["Discount Percent",             c => ""],
  ["Item Discount Amount",         c => ""],
  ["Store Credit",                 c => ""],
  ["Item Tax",                     c => ""],
  ["Total Tax",                    c => ""],
  ["Shipping Invoiced",            c => ""],
  ["Shipping Tax",                 c => ""],
  ["Account Number",               c => c.cfg.accountNumber],
  ["Net Price",                    c => perUnit(g(c.row,"SKU Subtotal Before Discount"), g(c.row,"Quantity"))],
  ["ProductGroupType",             c => c.cfg.productGroupType],
];

// ---- Helpers -------------------------------------------------------------

// Read a source field by header name and trim stray spaces/tabs/newlines.
function g(row, key) {
  const v = row[key];
  if (v === undefined || v === null) return "";
  return String(v).replace(/\s+$/g, "").replace(/^\s+/g, "");
}

function money(v) {
  if (v === "" || v === undefined || v === null) return "";
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  if (!isFinite(n)) return "";
  return round2(n);
}

function perUnit(subtotal, qty) {
  const s = parseFloat(String(subtotal).replace(/[^0-9.\-]/g, ""));
  const q = parseInt(qty, 10);
  if (!isFinite(s)) return "";
  if (!q || q <= 0) return round2(s);
  return round2(s / q);
}

function round2(n) {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return String(r);
}

// "06/03/2026 12:15:08 PM" -> "06-03-2026"
function formatDate(v) {
  if (!v) return "";
  const datePart = String(v).trim().split(/\s+/)[0]; // 06/03/2026
  return datePart.replace(/\//g, "-");
}

// "(+1)9854699604" -> "+19854699604"
function cleanPhone(v) {
  if (!v) return "";
  const cleaned = String(v).replace(/[^\d+]/g, "");
  return cleaned;
}

function firstName(full) {
  const parts = String(full).trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[0] : "";
}
function lastName(full) {
  const parts = String(full).trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
}

function stateAbbr(name) {
  const key = String(name).trim().toLowerCase();
  if (STATE_ABBR[key]) return STATE_ABBR[key];
  // already an abbreviation?
  if (/^[A-Za-z]{2}$/.test(String(name).trim())) return String(name).trim().toUpperCase();
  return String(name).trim();
}

function countryAbbr(name) {
  const key = String(name).trim().toLowerCase();
  return COUNTRY_ABBR[key] || String(name).trim();
}

function productName(c) {
  const base = g(c.row, "Product Name");
  const variation = g(c.row, "Variation");
  if (c.cfg.appendVariation && variation) {
    return base ? base + " - " + variation : variation;
  }
  return base;
}

// ---- Pipe serializer: quote a value only when it needs it ----------------
// (matches the sample ERP file: anything with a space, pipe, quote or newline
//  gets wrapped in double-quotes; internal quotes are doubled.)
function pipeField(value) {
  const s = value === undefined || value === null ? "" : String(value);
  if (/[\s"|]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildOutput(rows, cfg) {
  const header = COLUMNS.map(col => pipeField(col[0])).join("|");
  const lines = [header];
  for (const row of rows) {
    const ctx = { cfg, row };
    const cells = COLUMNS.map(col => pipeField(col[1](ctx)));
    lines.push(cells.join("|"));
  }
  // CRLF line endings — safest for ERP / Windows imports.
  return lines.join("\r\n") + "\r\n";
}

// ---- Config persistence --------------------------------------------------
const FIELD_IDS = ["orderPrefix","orderStatus","shipMethod","paymentMethod",
  "email","accountNumber","productGroupType","orderDate"];
const DEFAULTS = {
  orderPrefix: "ATXSECRET#",
  orderStatus: "unfulfilled",
  shipMethod: "US1",
  paymentMethod: "PayPal Payflow Pro",
  email: "",
  accountNumber: "99999280",
  productGroupType: "MULTI",
  orderDate: ""
};

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("ttCfg") || "{}"); } catch (e) {}
  for (const id of FIELD_IDS) {
    const el = document.getElementById(id);
    el.value = (saved[id] !== undefined) ? saved[id] : DEFAULTS[id];
  }
  const av = document.getElementById("appendVariation");
  av.checked = saved.appendVariation !== undefined ? saved.appendVariation : true;
}

function readConfig() {
  const cfg = {};
  for (const id of FIELD_IDS) cfg[id] = document.getElementById(id).value.trim();
  cfg.appendVariation = document.getElementById("appendVariation").checked;
  try { localStorage.setItem("ttCfg", JSON.stringify(cfg)); } catch (e) {}
  return cfg;
}

// ---- Order ID filter -----------------------------------------------------
// Empty box -> keep everything. Otherwise keep only the listed Order IDs.
// Accepts IDs separated by new lines, spaces, commas, tabs or semicolons.
function parseFilterIds() {
  const raw = document.getElementById("orderFilter").value;
  const ids = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  return new Set(ids);
}

function getFilteredRows() {
  if (!parsedRows) return [];
  const ids = parseFilterIds();
  if (ids.size === 0) return parsedRows;
  return parsedRows.filter(r => ids.has(g(r, "Order ID")));
}

// ---- App wiring ----------------------------------------------------------
let parsedRows = null;

const fileInput = document.getElementById("file");
const drop = document.getElementById("drop");
const fileinfo = document.getElementById("fileinfo");
const exportBtn = document.getElementById("export");
const statusEl = document.getElementById("status");

drop.addEventListener("click", () => fileInput.click());
["dragover","dragenter"].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.add("over");
}));
["dragleave","drop"].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.remove("over");
}));
drop.addEventListener("drop", e => {
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
fileInput.addEventListener("change", e => {
  const f = e.target.files[0];
  if (f) handleFile(f);
});

function handleFile(file) {
  fileinfo.textContent = "Reading " + file.name + " …";
  Papa.parse(file, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: h => h.trim(),
    complete: (res) => {
      parsedRows = res.data.filter(r => g(r, "Order ID"));
      fileinfo.innerHTML = "<strong>" + file.name + "</strong> — " +
        parsedRows.length + " line item(s) loaded.";
      exportBtn.disabled = parsedRows.length === 0;
      renderPreview();
    },
    error: (err) => {
      fileinfo.textContent = "Error reading file: " + err.message;
    }
  });
}

function renderPreview() {
  if (!parsedRows || !parsedRows.length) return;
  const cfg = readConfig();
  const rows = getFilteredRows();
  updateFilterInfo();
  const sample = rows.slice(0, 8);
  const table = document.getElementById("preview");
  let html = "<thead><tr>" + COLUMNS.map(c => "<th>" + esc(c[0]) + "</th>").join("") + "</tr></thead>";
  html += "<tbody>";
  for (const row of sample) {
    const ctx = { cfg, row };
    html += "<tr>" + COLUMNS.map(c => "<td>" + esc(c[1](ctx)) + "</td>").join("") + "</tr>";
  }
  html += "</tbody>";
  table.innerHTML = html;
  document.getElementById("rowcount").textContent =
    "(showing " + sample.length + " of " + rows.length + " rows)";
  document.getElementById("previewWrap").hidden = false;
}

// Show how many orders matched the filter (and warn about IDs not in the file).
function updateFilterInfo() {
  const info = document.getElementById("filterInfo");
  if (!parsedRows) return;
  const ids = parseFilterIds();
  if (ids.size === 0) {
    info.textContent = "One per line, or separated by spaces/commas. Empty = keep all orders.";
    info.style.color = "";
    return;
  }
  const present = new Set(parsedRows.map(r => g(r, "Order ID")));
  const matched = [...ids].filter(id => present.has(id));
  const missing = [...ids].filter(id => !present.has(id));
  const lineItems = getFilteredRows().length;
  let msg = matched.length + " of " + ids.size + " order(s) found → " + lineItems + " line item(s) will be exported.";
  if (missing.length) msg += "  ⚠ Not in file: " + missing.join(", ");
  info.textContent = msg;
  info.style.color = missing.length ? "#ffb547" : "var(--ok)";
}

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// Re-render preview when static values change.
FIELD_IDS.forEach(id => document.getElementById(id).addEventListener("input", () => {
  if (parsedRows) renderPreview();
}));
document.getElementById("appendVariation").addEventListener("change", () => {
  if (parsedRows) renderPreview();
});
document.getElementById("orderFilter").addEventListener("input", () => {
  if (parsedRows) renderPreview();
});

exportBtn.addEventListener("click", () => {
  if (!parsedRows || !parsedRows.length) return;
  const cfg = readConfig();
  const rows = getFilteredRows();
  if (!rows.length) {
    statusEl.textContent = "Nothing to export — no orders matched the filter.";
    return;
  }
  const out = buildOutput(rows, cfg);
  const blob = new Blob([out], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = "tiktok_erp_" + stamp + ".csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  statusEl.textContent = "Exported " + rows.length + " rows ✓";
});

loadConfig();
