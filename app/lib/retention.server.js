import { cleanupOldFeedback } from "../models/ChatFeedback.server";
import { cleanupOldMentions } from "../models/ChatProductMention.server";
import { cleanupOldTopics } from "../models/ChatTopic.server";
import { cleanupOldUsage } from "../models/ChatUsage.server";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function runOnce() {
  try {
    await cleanupOldFeedback();
  } catch (err) {
    console.error("[retention] cleanupOldFeedback failed:", err?.message || err);
  }
  try {
    await cleanupOldMentions();
  } catch (err) {
    console.error("[retention] cleanupOldMentions failed:", err?.message || err);
  }
  try {
    await cleanupOldTopics();
  } catch (err) {
    console.error("[retention] cleanupOldTopics failed:", err?.message || err);
  }
  try {
    await cleanupOldUsage();
  } catch (err) {
    console.error("[retention] cleanupOldUsage failed:", err?.message || err);
  }
}

// Idempotent: a single timer per Node process. The guard survives HMR in dev
// (where this module is re-imported on file changes) and prevents stacking
// intervals on multiple imports in production.
export function startRetentionScheduler() {
  if (globalThis.__seosRetentionStarted) return;
  globalThis.__seosRetentionStarted = true;

  // First sweep five minutes after boot — enough for the DB to be reachable
  // but not so long that data lingers across restarts.
  setTimeout(() => {
    runOnce();
    setInterval(runOnce, ONE_DAY_MS).unref();
  }, 5 * 60 * 1000).unref();
}
