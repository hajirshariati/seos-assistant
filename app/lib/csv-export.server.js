function escapeCell(value) {
  if (value == null) return "";
  let s = String(value);
  // Formula-injection guard: customer-typed chat text flows into these
  // exports verbatim, and spreadsheet apps execute cells starting with
  // = + - @ (or tab/CR) when the merchant opens the file. Prefix a
  // single quote so the cell renders as text. (OWASP CSV injection.)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers, rows) {
  const head = headers.map(escapeCell).join(",");
  const body = rows.map((r) => r.map(escapeCell).join(",")).join("\n");
  return `${head}\n${body}\n`;
}

export function csvResponse(filename, csv) {
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]+/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}
