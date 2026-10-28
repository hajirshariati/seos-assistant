// Product specs — reading an uploaded sheet and keeping it (Catalog →
// Product specs). The cleaning and matching rules live in product-specs.js;
// the catalog matches the stored rows to products each time it loads.

import prisma from "../db.server.js";
import { readXlsx, XlsxError } from "./xlsx-read.server.js";
import { parseCsv } from "./csv.server.js";
import { readSpecSheet } from "./product-specs.js";

export const SPEC_FILE_MAX_BYTES = 8 * 1024 * 1024;

// An upload ({ fileName, base64 }) → { rows, report } or { error }.
export function readSpecUpload({ fileName = "", base64 = "" } = {}) {
  const name = String(fileName || "").trim().slice(0, 200) || "specs";
  const data = String(base64 || "").replace(/^data:[^,]*,/, "");
  // Base64 is 4 characters for every 3 bytes.
  if (!data || data.length * 0.75 > SPEC_FILE_MAX_BYTES) {
    return { error: data ? `That file is too large — the limit is ${SPEC_FILE_MAX_BYTES / 1024 / 1024} MB.` : "Choose an Excel (.xlsx) or CSV file first." };
  }
  const buf = Buffer.from(data, "base64");
  let tabs;
  try {
    if (/\.xlsx$/i.test(name) || (buf[0] === 0x50 && buf[1] === 0x4b)) tabs = readXlsx(buf);
    else if (/\.(csv|txt)$/i.test(name)) {
      const { headers, rows } = parseCsv(buf.toString("utf8").replace(/^\uFEFF/, ""));
      tabs = [{ name: name.replace(/\.(csv|txt)$/i, ""), rows: [headers, ...rows] }];
    } else return { error: "Upload an Excel workbook (.xlsx) or a CSV file. Older .xls files: open in Excel and save as .xlsx." };
  } catch (err) {
    return { error: err instanceof XlsxError ? err.message : "This file couldn't be read. Save it as .xlsx or CSV and try again." };
  }
  const sheet = readSpecSheet(tabs);
  if (!sheet.rows.length) {
    return { error: "No style codes found. The sheet needs a column of style codes (like “Style #”) and columns such as “Removable Depth”, “Contains Pig Products”, “Shank”, “Lining”." };
  }
  return sheet;
}

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

export async function getSpecSheet(shop) {
  const row = await prisma.productSpecSheet.findUnique({ where: { shop } }).catch(() => null);
  if (!row) return null;
  return { fileName: row.fileName, rows: parse(row.rowsJson, []), report: parse(row.reportJson, {}), updatedAt: row.updatedAt };
}

// Only the rows, for the catalog (a table not migrated yet → none).
export async function getSpecRows(shop) {
  const row = await prisma.productSpecSheet.findUnique({ where: { shop }, select: { rowsJson: true } }).catch(() => null);
  const rows = row ? parse(row.rowsJson, []) : [];
  return Array.isArray(rows) ? rows : [];
}

export async function saveSpecSheet(shop, { fileName, rows, report }) {
  const data = { fileName: String(fileName || "specs").slice(0, 200), rowsJson: JSON.stringify(rows), reportJson: JSON.stringify(report || {}) };
  await prisma.productSpecSheet.upsert({ where: { shop }, update: data, create: { shop, ...data } });
}

export async function deleteSpecSheet(shop) {
  await prisma.productSpecSheet.deleteMany({ where: { shop } });
}
