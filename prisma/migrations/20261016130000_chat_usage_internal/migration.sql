-- Admin test chats are recorded for the cost estimate, flagged so customer
-- analytics, the daily cap and exports keep excluding them.
ALTER TABLE "ChatUsage" ADD COLUMN IF NOT EXISTS "internal" BOOLEAN NOT NULL DEFAULT false;
