// Conversation recording for testing (Settings → Test recordings). Pure rules
// shared by the chat route, widget-config, the admin pages and the evals.
//
// Recording is off unless the store turns it on, and then only for two weeks
// at a time. By default only "testers" are recorded: people who opened the
// store with the tester link (?hajirai_tester=Name), never ordinary shoppers.
// Chats from the app's own Test chat are recorded too while it's on.

export const RECORD_DAYS = 14;
export const KEEP_DAYS = 30;

export function recordingState(config, now = new Date()) {
  const until = config?.recordChatsUntil ? new Date(config.recordChatsUntil) : null;
  const on = Boolean(until && !Number.isNaN(until.getTime()) && until > now);
  return { on, until: on ? until : null, scope: config?.recordChatsScope === "everyone" ? "everyone" : "testers" };
}

// The tester's name from the link: letters, digits, spaces and . _ - only.
export function cleanTester(value) {
  return String(value || "").normalize("NFKC").replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function shouldRecord(config, { tester = "", internal = false, now = new Date() } = {}) {
  const st = recordingState(config, now);
  if (!st.on) return false;
  if (internal) return true;
  return st.scope === "everyone" || Boolean(cleanTester(tester));
}

// One line on what came with the reply, for the transcript.
export function describeExtras(events = []) {
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "support_cta") out.push("support button");
    else if (e.type === "visualize_cta") out.push("See It Styled");
    else if (e.type === "size_finder") out.push("True Fit size finder");
    else if (e.type === "fitfinder_fit") out.push(`FIT ${e.key}`);
    else if (e.type === "fit_report") out.push(`fit report ${e.recommendedSize || ""}`.trim());
    else if (e.type === "klaviyo_form") out.push("sign-up form");
    else if (e.type === "login_prompt") out.push("sign-in button");
    else if (e.type === "order_cards" && Array.isArray(e.orders)) out.push(`orders: ${e.orders.map((o) => `#${o.number} ${o.stageLabel}`).join(", ")}`);
    else if (e.type === "link" && e.label) out.push(`link: ${e.label}`);
    else if (e.type === "suggestions" && Array.isArray(e.questions)) out.push(`suggested: ${e.questions.slice(0, 4).join(" | ")}`);
  }
  return out.join(" · ").slice(0, 600);
}

// Sessions for the admin page: turns grouped by chat, newest chat first.
export function groupSessions(rows = []) {
  const bySession = new Map();
  for (const r of rows) {
    const key = r.sessionId || r.id;
    if (!bySession.has(key)) bySession.set(key, { sessionId: key, tester: r.tester || "", page: r.page || "", turns: [] });
    const s = bySession.get(key);
    s.turns.push(r);
    if (!s.tester && r.tester) s.tester = r.tester;
  }
  const sessions = [...bySession.values()];
  for (const s of sessions) {
    s.turns.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    s.startedAt = s.turns[0]?.createdAt;
    s.lastAt = s.turns[s.turns.length - 1]?.createdAt;
    s.failed = s.turns.filter((t) => !t.ok).length;
  }
  return sessions.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
}
