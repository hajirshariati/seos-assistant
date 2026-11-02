// Chat guard, applied to one message (rules in chat-guard.js, state in
// ChatGuard.server.js). Called by the chat route before the engine runs.
//
//   guardMessage(...) → { ended, until, message }           the chat is ended: no AI call
//                     → { mark, note, warn, flag }          counted: carry on (maybe warned)
//                     → null                                nothing to do
import Anthropic from "@anthropic-ai/sdk";
import { CHECK_MODEL } from "./claude-models.js";
import {
  guardMode, phraseCategory, judgeQuestion, nextStrike, isLocked, lockUntil, endedMessage, guardNote,
  IP_STRIKES_TO_END, IP_WINDOW_MS,
} from "./chat-guard.js";
import { getGuardStates, saveGuardState, sessionKey, ipKey } from "../models/ChatGuard.server.js";
import { setFlag } from "../models/ChatFlag.server.js";

// The model's own look at a message the phrase list picked out: YES, NO, or
// null when it couldn't answer in time (which never counts).
export async function judgeOffTrack({ apiKey, message, kind, client = null }) {
  const ai = client || new Anthropic({ apiKey, timeout: 6000, maxRetries: 0 });
  try {
    const resp = await ai.messages.create({ model: CHECK_MODEL, max_tokens: 5, messages: [{ role: "user", content: judgeQuestion(message, kind) }] }, { timeout: 6000 });
    const word = (Array.isArray(resp?.content) ? resp.content : []).filter((b) => b.type === "text").map((b) => b.text).join("").trim().toUpperCase();
    return word.startsWith("YES") ? true : word.startsWith("NO") ? false : null;
  } catch (err) {
    console.error("[guard] check failed:", err?.message || err);
    return null;
  }
}

// The kinds of message that struck this chat so far, oldest first, for the
// flag's note: read from the stored state's history string.
const kindsOf = (state) => String(state?.lastCategory || "").split(",").filter(Boolean);

export async function guardMessage({
  shop, config, message, sessionId, ip, typed = null, tester = "", internal = false, signedIn = false, supportLabel = "", now = new Date(), judge = judgeOffTrack,
}) {
  const mode = guardMode(config);
  if (mode === "off" || internal || tester) return null;
  const sKey = sessionKey(sessionId);
  const iKey = ipKey(ip);
  const states = await getGuardStates(shop, [sKey, iKey]);
  const sessionState = states[sKey];
  const ipState = states[iKey];
  // Ended: nothing reaches the model until the lock passes.
  if (mode === "on" && (isLocked(sessionState, now) || (!signedIn && isLocked(ipState, now)))) {
    const until = [sessionState?.lockedUntil, ipState?.lockedUntil].filter(Boolean).map((d) => new Date(d)).sort((a, b) => b - a)[0];
    return { ended: true, until, message: endedMessage({ until, now, supportLabel }) };
  }
  // Signal one: the phrase list.
  const kind = phraseCategory(message, { typed });
  if (!kind) return null;
  // Signal two: the model. Not sure (or not reachable) never counts.
  const sure = await judge({ apiKey: config.anthropicApiKey, message, kind });
  if (sure !== true) return null;

  // The chat's own count. lastCategory holds every kind so far ("a,b"); the
  // repeat rule looks at the last.
  const soFar = kindsOf(sessionState);
  const s = nextStrike({ ...sessionState, lastCategory: soFar[soFar.length - 1] || "" }, { category: kind, now });
  if (!s.strike) return null;
  const kinds = [...(s.state.strikes === 1 ? [] : soFar), kind];
  const sessionNext = { ...s.state, lastCategory: kinds.join(",") };

  // The address's count (never for signed-in customers).
  let ipEnd = false;
  if (!signedIn) {
    const i = nextStrike(ipState, { category: `${kind}@${sessionId}`, now, toEnd: IP_STRIKES_TO_END, windowMs: IP_WINDOW_MS });
    ipEnd = i.end;
    const ipNext = i.state;
    if (ipEnd && mode === "on") ipNext.lockedUntil = lockUntil(now);
    await saveGuardState(shop, iKey, ipNext);
  }

  const end = s.end || ipEnd;
  if (end && mode === "on" && !signedIn) {
    sessionNext.lockedUntil = lockUntil(now);
    await saveGuardState(shop, sKey, sessionNext);
    await setFlag(shop, sessionId, { kind: "guard", note: guardNote(kinds, { mode }) }).catch((err) => console.error("[guard] flag failed:", err?.message || err));
    return { ended: true, until: sessionNext.lockedUntil, message: endedMessage({ until: sessionNext.lockedUntil, now, supportLabel }), mark: `end:${kind}`, kinds };
  }
  if (end) {
    // Watch mode, or a signed-in customer: flagged for the team, the count
    // starts over, the shopper notices nothing.
    await saveGuardState(shop, sKey, { strikes: 0, lastCategory: "", lastStrikeAt: null, lockedUntil: null });
    await setFlag(shop, sessionId, { kind: "watch", note: guardNote(kinds, { mode: mode === "watch" ? "watch" : "signed-in" }) }).catch((err) => console.error("[guard] flag failed:", err?.message || err));
    return { ended: false, mark: `watch:${kind}`, warn: false, kinds, strikes: s.state.strikes };
  }
  await saveGuardState(shop, sKey, sessionNext);
  // "warn" marks the message whose reply carried the warning (on mode only).
  const warn = s.warn && mode === "on";
  return { ended: false, mark: `${warn ? "warn" : "strike"}:${kind}`, warn, kinds, strikes: s.state.strikes };
}
