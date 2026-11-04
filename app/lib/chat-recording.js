// Conversation recording (Settings → Recording). Pure rules shared by the
// chat route, widget-config, the admin pages and the evals.
//
// Recording is off unless the store turns it on, and stays on until the
// store turns it off. By default only "testers" are recorded: people who
// opened the store with the tester link (?hajirai_tester=Name), never
// ordinary shoppers. Chats from the app's own Test chat are recorded too
// while it's on. Chats are kept `keepDays` (the store's choice), except
// flagged chats, which stay as long as the flag does. Nothing is deleted
// by hand.

export const KEEP_DAYS_CHOICES = [30, 90, 180, 365];
export const DEFAULT_KEEP_DAYS = 90;

export function keepDays(config) {
  const n = Number(config?.recordKeepDays);
  return KEEP_DAYS_CHOICES.includes(n) ? n : DEFAULT_KEEP_DAYS;
}

export function recordingState(config) {
  return { on: config?.recordChatsOn === true, scope: config?.recordChatsScope === "everyone" ? "everyone" : "testers", keepDays: keepDays(config) };
}

// The tester's name from the link: letters, digits, spaces and . _ - only.
export function cleanTester(value) {
  return String(value || "").normalize("NFKC").replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function shouldRecord(config, { tester = "", internal = false } = {}) {
  const st = recordingState(config);
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
    else if (e.type === "size_intro" && Array.isArray(e.lines)) out.push(`True Fit — pick a shoe: ${(e.lines.find((l) => l.k === e.line) || e.lines[0])?.tiles?.map((t) => t.l).join(", ") || ""}`);
    else if (e.type === "fitfinder_fit") out.push(`FIT ${e.key}`);
    else if (e.type === "fit_report") out.push(`fit report ${e.recommendedSize || ""}`.trim());
    else if (e.type === "klaviyo_form") out.push("sign-up form");
    else if (e.type === "map_cta") out.push(`store map button: ${e.label || "Find a store near you"}`);
    else if (e.type === "form_cta") out.push(`quiz button: ${e.label || "Identify my orthotic"}`);
    else if (e.type === "view_all") out.push(e.label || "View all");
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

// Labels for the admin page, in the store's time zone, worked out on the
// server so the page reads the same before and after it loads: each chat's
// day ("Today", "Yesterday", "Mon, Oct 20") and week ("This week", "Last
// week", "Week of Oct 6", weeks starting Monday), and short times.
const keyDate = (key) => new Date(`${key}T12:00:00Z`);
const shiftKey = (key, days) => {
  const d = keyDate(key);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (key) => shiftKey(key, -((keyDate(key).getUTCDay() + 6) % 7));
const utcFmt = (opts) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts });

function zoneFmt(timeZone, opts) {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "UTC", ...opts }); }
  catch { return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }); }
}

// The UTC instants a store-local day ("2026-10-30", in the store's time
// zone) starts and ends at — for "Delete day". Pure; DST-safe (the offset
// is read at each end).
export function dayBounds(key, timeZone = "") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ""))) return null;
  const fmt = zoneFmt(timeZone, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const offsetAt = (instant) => {
    const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instant.getTime();
  };
  const localMidnight = (k) => {
    const guess = new Date(`${k}T00:00:00Z`);
    let t = new Date(guess.getTime() - offsetAt(guess));
    t = new Date(guess.getTime() - offsetAt(t));
    return t;
  };
  const start = localMidnight(key);
  const end = localMidnight(shiftKey(key, 1));
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start ? null : { start, end };
}

export function recordingLabels({ timeZone = "", now = new Date() } = {}) {
  const dayKey = dayKeyOf(timeZone);
  const today = dayKey(now);
  const yesterday = shiftKey(today, -1);
  const thisWeek = mondayOf(today);
  const lastWeek = shiftKey(thisWeek, -7);
  const dayName = utcFmt({ weekday: "short", month: "short", day: "numeric" });
  const shortDay = utcFmt({ month: "short", day: "numeric" });
  const time = zoneFmt(timeZone, { hour: "numeric", minute: "2-digit" });
  const dateTime = zoneFmt(timeZone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return {
    day(date) {
      const key = dayKey(date);
      return { key, label: key === today ? "Today" : key === yesterday ? "Yesterday" : dayName.format(keyDate(key)) };
    },
    week(date) {
      const key = mondayOf(dayKey(date));
      return { key, label: key === thisWeek ? "This week" : key === lastWeek ? "Last week" : `Week of ${shortDay.format(keyDate(key))}` };
    },
    time: (date) => time.format(new Date(date)),
    dateTime: (date) => dateTime.format(new Date(date)),
  };
}

function dayKeyOf(timeZone) {
  const fmt = zoneFmt(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return (date) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
}
