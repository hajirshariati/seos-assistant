-- Recordings: who on the team flagged a chat (the comment lives in "note").
ALTER TABLE "ChatFlag" ADD COLUMN "flaggedBy" TEXT NOT NULL DEFAULT '';
