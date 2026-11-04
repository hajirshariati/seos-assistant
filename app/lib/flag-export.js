// The flagged chats, written up for review — one plain-text (Markdown)
// file the team downloads and hands over with their comments. Everything
// needed to work out what should change is in it: each chat's comment and
// who left it, the shoppers' own votes on the chat, what the chat review
// found, and the whole transcript — what was shown under each reply,
// failed turns, the guard's marks. Pure; the exports route gathers the
// rows (app/routes/app.exports.jsx).
import { recordingLabels } from "./chat-recording.js";
import { guardTurnLabel } from "./chat-guard.js";
import { FEEDBACK_REASONS, FEEDBACK_MOMENTS, FEEDBACK_SUBJECTS } from "./chat-rating.js";

export const FLAG_KIND_WORDS = { manual: "Flagged by the team", guard: "Ended by the chat guard", watch: "The chat guard would have ended it" };

const one = (s) => String(s || "").replace(/\s+/g, " ").trim();
const block = (s) => String(s || "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
const quote = (s) => block(s).split("\n").map((l) => `> ${l}`).join("\n");
const n = (count, word, words = `${word}s`) => `${count} ${count === 1 ? word : words}`;

// chats: [{ sessionId, tester, page, startedAt, flag: { kind, note, by, at },
// turns: [{ at, message, reply, products, extras, ok, guard }],
// votes: [{ at, vote, kind, reason, moment, comment, response }],
// findings: [{ at, subject, problem, note, better, reply }] }]
export function flaggedChatsReport({ shop = "", exportedAt = new Date(), timeZone = "", chats = [] } = {}) {
  const L = recordingLabels({ timeZone, now: exportedAt });
  const when = (d) => (d ? L.dateTime(d) : "");
  const ordered = [...chats].sort((a, b) => new Date(b.flag?.at || b.startedAt || 0) - new Date(a.flag?.at || a.startedAt || 0));
  const byTeam = ordered.filter((c) => c.flag?.kind === "manual");
  const byGuard = ordered.length - byTeam.length;
  const out = [];
  out.push(`# Flagged chats — ${shop || "the store"}`);
  out.push("");
  out.push(`Exported ${when(exportedAt)}${timeZone ? ` (${timeZone})` : ""}. ${n(ordered.length, "flagged chat")}: ${byTeam.length} flagged by the team${byGuard ? `, ${byGuard} by the chat guard` : ""}.`);
  out.push("");
  out.push("For each chat: the team's comment, the shopper's own votes, what the daily chat review found, then the whole transcript oldest first — with what was shown under each reply, failed turns and the chat guard's marks. Times are the store's. Contact details were removed when the chat was saved.");
  const commented = byTeam.filter((c) => one(c.flag.note));
  if (commented.length) {
    out.push("");
    out.push("## The team's comments at a glance");
    out.push("");
    commented.forEach((c) => {
      const i = ordered.indexOf(c) + 1;
      out.push(`${i}. ${one(c.flag.note)} — ${who(c)}, ${when(c.startedAt)}`);
    });
  }
  ordered.forEach((c, k) => {
    out.push("");
    out.push("---");
    out.push("");
    out.push(`## ${k + 1}. ${who(c)} · ${when(c.startedAt)} · ${n(c.turns?.length || 0, "message")}`);
    out.push("");
    out.push(`Chat ${c.sessionId}${c.page ? ` · started on ${c.page}` : ""}`);
    const f = c.flag || {};
    const name = f.by ? ` by ${f.by}` : "";
    if (f.kind === "manual") {
      out.push("");
      out.push(`**Team comment**${name}${f.at ? ` (${when(f.at)})` : ""}:`);
      out.push("");
      out.push(one(f.note) ? quote(f.note) : "> (no comment left)");
    } else {
      out.push("");
      out.push(`**${FLAG_KIND_WORDS[f.kind] || "Flagged"}**${f.at ? ` (${when(f.at)})` : ""}${one(f.note) ? `: ${one(f.note)}` : ""}`);
    }
    const votes = c.votes || [];
    if (votes.length) {
      out.push("");
      out.push(`**${n(votes.length, "vote")} from the shopper:**`);
      out.push("");
      for (const v of votes) {
        const bits = [
          v.vote === "down" ? "👎 Not helpful" : "👍 Helpful",
          v.kind === "chat" ? "on the whole chat" : "on one reply",
          FEEDBACK_MOMENTS[v.moment] || "",
          FEEDBACK_REASONS[v.reason] || "",
          v.at ? when(v.at) : "",
        ].filter(Boolean);
        out.push(`- ${bits.join(" · ")}`);
        if (one(v.comment)) out.push(`  - Shopper's words: “${one(v.comment)}”`);
        if (v.kind !== "chat" && one(v.response)) out.push(`  - The reply voted on: “${one(v.response).slice(0, 400)}”`);
      }
    }
    const findings = c.findings || [];
    if (findings.length) {
      out.push("");
      out.push(`**What the chat review found (${n(findings.length, "answer")}):**`);
      out.push("");
      for (const g of findings) {
        out.push(`- ${FEEDBACK_SUBJECTS[g.subject] || g.subject || "Something else"} — ${one(g.problem)}${one(g.note) ? `: ${one(g.note)}` : ""}`);
        if (one(g.better)) out.push(`  - Better: ${one(g.better)}`);
        if (one(g.reply)) out.push(`  - The reply: “${one(g.reply).slice(0, 300)}”`);
      }
    }
    out.push("");
    out.push("### Transcript");
    const turns = c.turns || [];
    if (!turns.length) {
      out.push("");
      out.push("(The chat's messages are no longer kept.)");
    }
    let strikes = 0;
    turns.forEach((t, i) => {
      out.push("");
      const mark = t.guard || "";
      if (/^(strike|warn):/.test(mark)) strikes += 1;
      const label = mark ? guardTurnLabel(mark, strikes).replace(/\s*·\s*$/, "") : "";
      out.push(`**Shopper** (${i === 0 ? when(t.at) : L.time(t.at)}):`);
      out.push("");
      out.push(block(t.message) || "(nothing typed)");
      out.push("");
      out.push(`**AVA${t.ok === false ? " — the turn failed" : ""}:**`);
      out.push("");
      out.push(block(t.reply) || (t.ok === false ? "(no reply)" : ""));
      const products = (t.products || []).filter(Boolean);
      if (products.length) out.push(`> Products shown: ${products.map(one).join(" · ")}`);
      if (one(t.extras)) out.push(`> Also shown: ${one(t.extras)}`);
      if (label) out.push(`> Chat guard: ${label}`);
    });
  });
  return `${out.join("\n")}\n`;
}

function who(c) {
  return c.tester ? `Test chat · ${c.tester}` : "Shopper";
}
