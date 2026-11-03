// Talk to a person — the ways to reach the store team, offered in the chat's
// menu at any point (NYC DCWP 6 RCNY 5-312(c)): a live chat if the store
// has one, the phone with its hours, the email with its reply time. Pure.

export const HUMAN_MAX = { hours: 120, phone: 40, email: 120, reply: 60 };

// The AVA defaults are Aetrex's customer service.
const AVA_HUMAN = {
  hours: "Mon–Fri 8:30am–12am ET · Sat–Sun 9am–12am ET",
  phone: "1-888-526-2739",
  email: "help@aetrex.com",
  reply: "within 1 business day",
};

const str = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const email = (v) => { const e = str(v, HUMAN_MAX.email); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : ""; };
const phone = (v) => { const p = str(v, HUMAN_MAX.phone); return /^[+\d][\d\s().-]{5,}(\s*(ext|x)\.?\s*\d+)?$/i.test(p) ? p : ""; };

// The store's details, with the brand's defaults where a field is blank.
export function humanHelpFields(config, { brand = "SEoS" } = {}) {
  const d = brand === "AVA" ? AVA_HUMAN : { hours: "", phone: "", email: "", reply: "" };
  return {
    hours: str(config?.supportHours, HUMAN_MAX.hours) || d.hours,
    phone: phone(config?.supportPhone) || d.phone,
    email: email(config?.supportEmail) || d.email,
    reply: str(config?.supportReplyTime, HUMAN_MAX.reply) || d.reply,
  };
}

// What the widget gets: the rows of the "Talk to a person" card, in the
// order they're shown. The live-chat row is always first (the widget opens
// the store's live chat if there is one, else the support page); phone and
// email follow when the store gave them. `telHref` is the phone as a link.
export function humanHelpConfig(config, { brand = "SEoS", supportUrl = "", supportLabel = "" } = {}) {
  const f = humanHelpFields(config, { brand });
  return {
    hours: f.hours,
    phone: f.phone,
    telHref: f.phone ? `tel:${f.phone.replace(/\s*(ext|x)\.?\s*\d+$/i, "").replace(/[^\d+]/g, "")}` : "",
    email: f.email,
    reply: f.reply,
    liveLabel: str(supportLabel, 40) || "Live chat",
    liveUrl: str(supportUrl, 300),
  };
}

// The words a shopper reads on the card — one line per way, plain.
export function humanHelpLines(h) {
  const out = [];
  if (h.liveUrl || h.liveLabel) out.push({ kind: "live_chat", title: h.liveLabel || "Live chat", sub: h.hours || "" });
  if (h.phone) out.push({ kind: "phone", title: h.phone, sub: h.hours ? `Call us · ${h.hours}` : "Call us" });
  if (h.email) out.push({ kind: "email", title: h.email, sub: h.reply ? `Email us · we reply ${h.reply}` : "Email us" });
  return out;
}
