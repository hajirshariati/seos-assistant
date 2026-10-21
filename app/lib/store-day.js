// Calendar days in the store's own time zone (Shopify's ianaTimezone), so
// "today" on the dashboard turns over at the store's midnight — not at UTC
// midnight, which is 7–8pm on the US east coast.

// (date) → "YYYY-MM-DD" in the time zone; UTC if it's missing or unknown.
export function dayKeyIn(timeZone) {
  let fmt = null;
  if (timeZone) {
    try { fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); }
    catch { fmt = null; }
  }
  return (date) => {
    const d = date instanceof Date ? date : new Date(date);
    if (!fmt) return d.toISOString().slice(0, 10);
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
}

// Every day key from start to end (inclusive), in order. Steps by hours, not
// days, so a daylight-saving change never skips or doubles a day.
export function dayKeysBetween(start, end, key) {
  const keys = [];
  const last = key(end);
  for (let t = new Date(start).getTime(); t <= new Date(end).getTime(); t += 6 * 3600 * 1000) {
    const k = key(new Date(t));
    if (keys[keys.length - 1] !== k) keys.push(k);
  }
  if (keys[keys.length - 1] !== last) keys.push(last);
  return keys;
}
