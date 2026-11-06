// FITFinder in the chat. When the store's FIT finder can run inside the
// widget (its two questions and their table came with the message —
// `native`), the assistant doesn't ask the arch and ball-of-foot questions
// itself the first time orthotic support comes up: it puts the finder's card
// under its reply (open_fit_finder) and says in a sentence why it's worth
// the two taps. Submit there closes the finder, shows the FIT in the chat
// and sends the shopper's word, so the assistant carries on with the FIT
// known. A shopper who'd rather type gets the questions in the chat as
// before — once the card has been offered (`offered`), words are fine.

export const FIT_FINDER_TOOL = "open_fit_finder";

export const FIT_FINDER_TOOL_DEF = {
  name: FIT_FINDER_TOOL,
  description:
    "Put the store's FIT finder card under your reply: two quick taps (flat feet? ball-of-foot pain?) that work out the customer's FIT — the orthotic support they need — right in the chat; the chat carries on by itself once they submit. " +
    "Use it the first time you need their arch type or ball-of-foot pain for an orthotic and they don't have a FIT yet, instead of asking those two questions. " +
    "Your words with it: one friendly sentence on why it's worth the taps, and that they can also just answer you here. Not when they already have a FIT (you'd have been told), and not twice in one conversation.",
  input_schema: { type: "object", properties: {} },
};

// The tool's answer: the card goes under the reply.
export function fitFinderToolResult(questionCount = 2) {
  const n = Math.max(1, Math.min(4, Number(questionCount) || 2));
  return {
    ok: true,
    note: `The FIT finder card is under your reply — ${n} quick question${n === 1 ? "" : "s"}; their FIT shows in the chat when they submit, and you carry on from there (the shoes it's for, who it's for, the pick). Say in one friendly sentence why it's worth the taps and that they can also just answer here. Don't list the questions yourself, and don't ask arch or ball-of-foot pain in this reply.`,
    _events: [{ type: "fitfinder_cta" }],
  };
}

// The line in the orthotic tool's text when the finder runs in the chat
// (the same for every shopper of the store: their own FIT is told apart).
export function fitFinderNativeNote(questionCount = 2) {
  const n = Math.max(1, Math.min(4, Number(questionCount) || 2));
  return `\n\nThe FIT finder in the chat: this store's own FIT finder (${n} quick tap${n === 1 ? "" : "s"} — flat feet? ball-of-foot pain?) runs right inside the chat. ` +
    `When you need their arch type or ball-of-foot pain and they don't have a FIT yet, don't ask those questions — call ${FIT_FINDER_TOOL} (its card goes under your reply), say in one friendly sentence why it's worth the taps (it works out the orthotic support they need, and their FIT is kept for product pages too) and that they can also just answer here. ` +
    "Ask the other things (who it's for, the shoes) as usual, before or after. If they answer in words instead of tapping, carry on with the questions here. " +
    "Once their FIT is known (the note about them, or their message), call this tool with fit and don't ask about arch or ball-of-foot pain again.";
}

// The in-store foot scan. A store whose FITFinder has the scan lookup on,
// in a widget that runs it (`scan`), can bring a customer's foot scan from
// one of its stores into the chat: the card under a reply opens the lookup
// — they sign in with the email they gave at the scan, and their scanned
// FIT comes up with a link to their scan report. The assistant never says
// it can't see a scan.
export const FOOT_SCAN_TOOL = "open_foot_scan";

export const FOOT_SCAN_TOOL_DEF = {
  name: FOOT_SCAN_TOOL,
  description:
    "Put the in-store foot scan card under your reply: a tap opens the customer's foot scan from one of our stores right in the chat — they sign in with the email they gave at the scan, and their scanned FIT comes up with a link to their scan report. " +
    "Use it whenever they ask to pull up, see, find or use their foot scan or scan results, say they were scanned in one of our stores (the foot scanner), or want the orthotic their scan recommended — even when they already have a FIT saved. " +
    "Never tell them you can't access or see their scan: it's a tap away. Your words with it: one friendly sentence that their scan is right here — sign in with the email from the scan and it comes up, with their FIT. Not for where to get scanned (that's the store locator).",
  input_schema: { type: "object", properties: {} },
};

// The tool's answer: the card goes under the reply.
export function footScanToolResult() {
  return {
    ok: true,
    note: "The foot scan card is under your reply. Say in one friendly sentence that their scan from our store is right here — a tap, a sign-in with the email they gave at the scan, and their scanned FIT comes up with their scan report; once they use it, their FIT is known and you can pick orthotics by it. Don't say you can't access the scan, and don't send them to a store or customer service for it.",
    _events: [{ type: "fitfinder_scan" }],
  };
}

// The customer asks for a scan they already had — "pull up my foot scan",
// "my scan results", "I was scanned at your store" — not where to get one.
const OWN_SCAN = /\b(?:my|our)\s+(?:(?:foot|feet|albert|3d|store|in-store|recent|last|old|previous)\s+)?scans?\b|\bscan\s+(?:results?|reports?|data|info|file)\b|\b(?:was|got|were|been|already|recently|just)\s+(?:\w+\s+){0,2}scanned\b|\bhad\s+(?:a|my|our)\s+(?:\w+\s+)?(?:scan|feet\s+scanned)\b|\bscanned\s+(?:my|our)\s+feet\b/i;
export function asksForOwnScan(text) {
  return OWN_SCAN.test(String(text || ""));
}
// A reply that says it can't reach the scan.
const CANT_SCAN = /\b(?:can(?:'|’)?t|cannot|unable to|not able to|don(?:'|’)?t have|no way to|not possible to|isn(?:'|’)?t (?:something|possible)|aren(?:'|’)?t able to)\b[^.!?\n]{0,60}\bscan/i;
export function deniesScan(text) {
  return CANT_SCAN.test(String(text || ""));
}

// Fact-check issues: the scan lookup is here, the customer asked for their
// scan (or the reply says it can't be reached), and the card wasn't offered
// — one rewrite, with the card.
export function footScanIssues({ latestUserMessage = "", text = "", called = [], available = [] } = {}) {
  if (!available.includes(FOOT_SCAN_TOOL) || called.includes(FOOT_SCAN_TOOL)) return [];
  if (!asksForOwnScan(latestUserMessage) && !deniesScan(text)) return [];
  return [{
    code: "foot_scan_not_offered",
    detail: `Their foot scan from one of our stores is a tap away right here in the chat — never say you can't access or see it. Call ${FOOT_SCAN_TOOL} so its card goes under your reply, then say in one friendly sentence that signing in with the email they gave at the scan brings it up here, with their FIT and their scan report. Keep the rest of your reply (what you acknowledged, the FIT they have on file if any). If they're asking where to get scanned, show the store locator instead.`,
  }];
}

// A reply that asks about the arch or ball-of-foot pain in words.
const FIT_QUESTION = /\b(arch(?:es)?|flat[- ](?:feet|foot|arches)|high[- ]arch|ball[- ]of[- ](?:(?:the|your|my|their)[- ])?foot|metatars\w*|neuroma|pronat\w*|(?:feet|foot) rolls?)\b/i;
export function asksFitQuestion(text, questions = []) {
  const t = String(text || "");
  if (!/\?/.test(t)) return false;
  if (FIT_QUESTION.test(t)) return true;
  const low = t.toLowerCase();
  return (Array.isArray(questions) ? questions : []).some((q) => {
    const stem = String(q?.text || "").toLowerCase().replace(/\?+$/, "").trim().slice(0, 30);
    return stem.length >= 8 && low.includes(stem);
  });
}

// Fact-check issues: the finder is here, the customer has no FIT, the card
// hasn't been offered in this chat, and the reply asks the questions in
// words instead — one rewrite, with the card.
export function fitFinderIssues({ text = "", called = [], available = [], fitfinder = null } = {}) {
  if (!available.includes(FIT_FINDER_TOOL) || called.includes(FIT_FINDER_TOOL)) return [];
  if (!fitfinder || fitfinder.native !== true || fitfinder.saved || fitfinder.offered === true) return [];
  if (!asksFitQuestion(text, fitfinder.questions)) return [];
  return [{
    code: "fit_finder_not_offered",
    detail: `You're asking about their arch or ball-of-foot pain in words, but this store's FIT finder answers both right here in the chat: call ${FIT_FINDER_TOOL} so its card goes under your reply, then say in one friendly sentence why it's worth the two taps (it works out the orthotic support they need) and that they can also just answer you here. Don't list those questions yourself; keep the rest of your reply (what you acknowledged, anything else you asked, like who it's for or the shoes).`,
  }];
}
