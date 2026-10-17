// A merchant-entered URL the server will call: https only, and never an
// address inside the server's own network (localhost, private ranges,
// cloud metadata). Returns the normalized URL, or null when not allowed.
const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function safeExternalUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host || host.startsWith("[")) return null; // IPv6 literal
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_V4.some((re) => re.test(host))) return null;
  if (/^\d+$/.test(host)) return null; // integer-form IP
  return u.toString();
}
