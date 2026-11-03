// Customer service log (NYC DCWP 6 RCNY 5-313) — the yearly numbers the rule
// asks for, from the ChatInteraction rows. Pure.
//
//   i.   total covered interactions in the year
//   ii.  resolved without a transfer option being used
//   iii. interactions by a visitor who had one in the previous 72 hours
//   iv.  interactions where the shopper used the transfer option
//   v.   interactions resolved without any shopper-initiated transfer
//   vi.  average duration

const H72 = 72 * 60 * 60 * 1000;

export function durationSeconds(row) {
  const a = new Date(row.startedAt).getTime();
  const b = new Date(row.lastAt).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : 0;
}

// Rows → per-year summaries (years in the given time zone's calendar are
// approximated by UTC; the rule leaves the form to the commissioner).
export function yearlySummary(rows = []) {
  const sorted = [...rows].sort((x, y) => new Date(x.startedAt) - new Date(y.startedAt));
  const lastByVisitor = new Map();
  const years = new Map();
  for (const r of sorted) {
    const at = new Date(r.startedAt).getTime();
    const year = new Date(r.startedAt).getUTCFullYear();
    if (!years.has(year)) years.set(year, { year, total: 0, resolvedWithoutTransfer: 0, repeatWithin72h: 0, transfersActivated: 0, noTransferAtAll: 0, durationTotal: 0 });
    const y = years.get(year);
    y.total += 1;
    const used = Boolean(r.humanActivated);
    if (!used) { y.resolvedWithoutTransfer += 1; y.noTransferAtAll += 1; }
    else y.transfersActivated += 1;
    if (r.visitor) {
      const prev = lastByVisitor.get(r.visitor);
      if (prev !== undefined && at - prev <= H72 && at > prev) y.repeatWithin72h += 1;
      lastByVisitor.set(r.visitor, at);
    }
    y.durationTotal += durationSeconds(r);
  }
  return [...years.values()].map((y) => ({ ...y, averageDurationSeconds: y.total ? Math.round(y.durationTotal / y.total) : 0 }));
}

export const OUTCOME_WORDS = { live_chat: "live chat", phone: "phone", email: "email", page: "support page", "": "" };

// One CSV row per chat.
export function interactionRow(r, disclosures = new Map()) {
  return [
    new Date(r.startedAt).toISOString(),
    new Date(r.lastAt).toISOString(),
    durationSeconds(r),
    r.sessionId,
    r.visitor || "",
    r.messages,
    r.signedIn ? "yes" : "no",
    r.humanOffered ? "yes" : "no",
    r.humanActivated ? "yes" : "no",
    OUTCOME_WORDS[r.outcome] || r.outcome || "",
    disclosures.get(r.disclosureId) || "",
  ];
}

export const INTERACTION_HEADERS = ["Started", "Ended", "Duration (s)", "Chat", "Visitor", "Messages", "Signed in", "Person offered", "Person requested", "How", "Opening words shown"];
export const SUMMARY_HEADERS = ["Year", "Total interactions", "Resolved without using the transfer option", "Repeat visitor within 72 hours", "Transfer option used", "Resolved without any transfer", "Average duration (s)"];
export const summaryRow = (y) => [y.year, y.total, y.resolvedWithoutTransfer, y.repeatWithin72h, y.transfersActivated, y.noTransferAtAll, y.averageDurationSeconds];
