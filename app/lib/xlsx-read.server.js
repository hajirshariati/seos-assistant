// Reads the cells of an Excel workbook (.xlsx) — every tab, as rows of
// text — with no dependency beyond Node's zlib. An .xlsx is a zip of XML
// files: the workbook lists the tabs, each tab's XML holds its cells, and
// shared strings hold the text. Only what's needed is unpacked, with hard
// size limits, so a hostile file can't exhaust memory.

import { inflateRawSync } from "node:zlib";

const MAX_ENTRY_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_ROWS_PER_TAB = 20000;
const MAX_CELLS = 600000;

export class XlsxError extends Error {}

function zipEntries(buf) {
  // End of central directory: the last 22+ bytes (a comment may follow).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError("This isn't an Excel (.xlsx) file.");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > 5000 || cdOffset >= buf.length) throw new XlsxError("This Excel file couldn't be read.");
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError("This Excel file couldn't be read.");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function unzipEntry(buf, entry, budget) {
  const p = entry.local;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new XlsxError("This Excel file couldn't be read.");
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compSize);
  const limit = Math.min(MAX_ENTRY_BYTES, budget.left);
  let out;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    try { out = inflateRawSync(data, { maxOutputLength: limit }); }
    catch { throw new XlsxError("This Excel file is too large or damaged."); }
  } else throw new XlsxError("This Excel file uses a format that can't be read.");
  if (out.length > limit) throw new XlsxError("This Excel file is too large.");
  budget.left -= out.length;
  return out.toString("utf8");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attrs(tag) {
  const out = {};
  for (const m of String(tag).matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
}

// All the text of a cell or shared string: its <t> runs, without the
// phonetic guides (<rPh>) Excel keeps for some languages.
function textRuns(xml) {
  const body = String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decode(m[1]);
  return out;
}

function columnIndex(ref) {
  const letters = String(ref || "").match(/^[A-Z]+/i)?.[0] || "";
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// buffer → [{ name, hidden, rows: [[cell text, …], …] }], in tab order.
export function readXlsx(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const entries = zipEntries(buf);
  const budget = { left: MAX_TOTAL_BYTES };
  const read = (name) => {
    const e = entries.get(name);
    return e ? unzipEntry(buf, e, budget) : null;
  };
  const workbook = read("xl/workbook.xml");
  if (!workbook) throw new XlsxError("This isn't an Excel (.xlsx) file.");
  const rels = new Map();
  for (const m of (read("xl/_rels/workbook.xml.rels") || "").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id && a.Target) rels.set(a.Id, a.Target);
  }
  const shared = [];
  for (const m of (read("xl/sharedStrings.xml") || "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1]));

  const tabs = [];
  let cells = 0;
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    const rid = a["r:id"] || Object.entries(a).find(([k]) => /:id$/.test(k))?.[1];
    let target = rels.get(rid);
    if (!target) continue;
    target = target.replace(/^\/+/, "");
    if (!target.startsWith("xl/")) target = `xl/${target}`;
    const xml = read(target);
    if (xml == null) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (rows.length >= MAX_ROWS_PER_TAB) break;
      const row = [];
      let next = 0;
      for (const c of String(r[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(c[1]);
        const idx = ca.r ? columnIndex(ca.r) : next;
        next = idx + 1;
        const inner = c[2] || "";
        const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
        let val = "";
        if (ca.t === "s") val = v != null ? shared[Number(v)] ?? "" : "";
        else if (ca.t === "inlineStr") val = textRuns(inner.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] || "");
        else if (ca.t === "b") val = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
        else if (ca.t === "e") val = "";
        else val = v != null ? decode(v) : "";
        if (idx < 0 || idx > 500 || !val.trim()) continue;
        if (++cells > MAX_CELLS) throw new XlsxError("This Excel file has too many cells.");
        row[idx] = val;
      }
      if (row.length) rows.push(Array.from(row, (x) => x ?? ""));
    }
    tabs.push({ name: a.name || `Sheet ${tabs.length + 1}`, hidden: a.state === "hidden" || a.state === "veryHidden", rows });
  }
  if (!tabs.length) throw new XlsxError("No tabs found in this Excel file.");
  return tabs;
}
