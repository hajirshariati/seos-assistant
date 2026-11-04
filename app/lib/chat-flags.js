// The team's comment on a flagged chat — the rules the page shares with
// the server (app/models/ChatFlag.server.js).
export const FLAG_NOTE_MAX = 2000;

export const cleanNote = (note) => String(note || "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, FLAG_NOTE_MAX);
