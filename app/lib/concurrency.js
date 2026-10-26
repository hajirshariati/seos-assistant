// A small concurrency limit: at most `max` tasks run at once; the rest wait
// their turn, up to a time limit, then fail with code AI_BUSY. Keeps a burst
// of shoppers from opening hundreds of AI calls on one server at the same
// moment (which only turns into rate-limit errors and memory). Pure.

export function createLimiter(max) {
  const limit = Math.max(1, Math.floor(Number(max) || 1));
  let active = 0;
  const queue = []; // waiting: { start }

  const next = () => {
    const w = queue.shift();
    if (w) w.start();
    else active -= 1;
  };

  return {
    get active() { return active; },
    get waiting() { return queue.length; },
    async run(fn, { waitMs = 15_000 } = {}) {
      if (active < limit) {
        active += 1;
      } else {
        // The slot is handed over directly (active stays the same).
        await new Promise((resolve, reject) => {
          const w = {};
          const timer = setTimeout(() => {
            const i = queue.indexOf(w);
            if (i >= 0) queue.splice(i, 1);
            reject(Object.assign(new Error("This server is busy with other AI requests"), { code: "AI_BUSY" }));
          }, Math.max(0, waitMs));
          w.start = () => { clearTimeout(timer); resolve(); };
          queue.push(w);
        });
      }
      try {
        return await fn();
      } finally {
        next();
      }
    },
  };
}
