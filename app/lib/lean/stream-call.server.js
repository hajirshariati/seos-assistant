// One model call, streamed: the words reach `onDraft` as they are written
// (the whole text so far each time), and the call still resolves to the
// same complete message `messages.create` would give — tool calls, usage
// and all — so the engine's reading of it is unchanged. A client without
// streaming (the evals' stand-ins) is called the plain way.
export async function streamModelCall(anthropic, req, { signal, timeout, onDraft } = {}) {
  if (typeof anthropic?.messages?.stream !== "function") return anthropic.messages.create(req, { signal, timeout });
  const stream = anthropic.messages.stream(req, { signal, timeout });
  if (typeof onDraft === "function") stream.on("text", (_delta, snapshot) => { try { onDraft(String(snapshot || "")); } catch { /* the draft is a courtesy */ } });
  return await stream.finalMessage();
}

// The drafts, at most one every `everyMs` and always the latest words; the
// final one on `flush`. The widget shows each in place of the last.
export function draftThrottle(send, { everyMs = 80, now = Date.now, schedule = setTimeout } = {}) {
  let last = 0, pending = null, timer = null;
  const emit = (text) => { last = now(); pending = null; send(text); };
  return {
    push(text) {
      const wait = everyMs - (now() - last);
      if (wait <= 0) { if (timer) { clearTimeout(timer); timer = null; } emit(text); return; }
      pending = text;
      if (!timer) timer = schedule(() => { timer = null; if (pending !== null) emit(pending); }, wait);
    },
    flush() { if (timer) { clearTimeout(timer); timer = null; } if (pending !== null) emit(pending); },
  };
}
