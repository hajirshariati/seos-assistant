import { cleanupOldFeedback } from "../models/ChatFeedback.server";
import { cleanupOldMentions } from "../models/ChatProductMention.server";
import { cleanupOldTopics } from "../models/ChatTopic.server";
import { cleanupOldUsage } from "../models/ChatUsage.server";
import { cleanupOldHealth } from "../models/ChatHealth.server";
import { cleanupOldRecordings } from "../models/ChatRecording.server";
import { cleanupOldReturns } from "../models/ChatReturn.server";
import { readAllPendingConcerns } from "./chat-concerns.server";

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
  // Shopper chats not read into "What shoppers ask about most" yet are read
  // before old recordings are deleted, so the all-time counts keep them.
  try {
    await readAllPendingConcerns();
  } catch (err) {
    console.error("[retention] readAllPendingConcerns failed:", err?.message || err);
  }
  try {
    await cleanupOldRecordings();
  } catch (err) {
    console.error("[retention] cleanupOldRecordings failed:", err?.message || err);
  }
  try {
    await cleanupOldReturns();
  } catch (err) {
    console.error("[retention] cleanupOldReturns failed:", err?.message || err);
  }
  await cleanupOldHealth();
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
