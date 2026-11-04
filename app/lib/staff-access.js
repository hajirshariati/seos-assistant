// The customer service team's list and the access rule — pure, so the
// Settings page can use them in the browser. staff-access.server.js adds
// the request helpers.
export const SUPPORT_STAFF_MAX = 50;

const email = (v) => String(v ?? "").trim().toLowerCase().slice(0, 254);
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// The saved list (JSON, or one address per line) → clean addresses.
export function parseSupportStaff(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else { try { const v = JSON.parse(raw); list = Array.isArray(v) ? v : []; } catch { list = String(raw ?? "").split(/[\n,;]/); } }
  const out = [];
  for (const v of list) { const e = email(v); if (looksLikeEmail(e) && !out.includes(e)) out.push(e); if (out.length >= SUPPORT_STAFF_MAX) break; }
  return out;
}

// "full" or "support" for this admin session: the owner is never limited.
export function staffAccess(session, config) {
  const u = session?.onlineAccessInfo?.associated_user;
  const e = email(u?.email);
  if (!e || u?.account_owner === true) return "full";
  return parseSupportStaff(config?.supportStaff).includes(e) ? "support" : "full";
}

// Who this admin session is, for the record: their name, else their email.
export function staffName(session) {
  const u = session?.onlineAccessInfo?.associated_user;
  const name = [u?.first_name, u?.last_name].map((v) => String(v || "").trim()).filter(Boolean).join(" ");
  return (name || email(u?.email)).slice(0, 120);
}
