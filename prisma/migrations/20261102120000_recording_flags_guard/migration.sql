-- Recording no longer stops on its own: on/off, with a keep-days setting.
ALTER TABLE "ShopConfig" ADD COLUMN "recordChatsOn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopConfig" ADD COLUMN "recordKeepDays" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "ShopConfig" ADD COLUMN "chatGuardMode" TEXT NOT NULL DEFAULT 'watch';
UPDATE "ShopConfig" SET "recordChatsOn" = true WHERE "recordChatsUntil" IS NOT NULL AND "recordChatsUntil" > NOW();
ALTER TABLE "ShopConfig" DROP COLUMN "recordChatsUntil";

-- Recorded turns: what the chat guard made of the message, and chats deleted
-- before "Top shopper issues & questions" read them.
ALTER TABLE "ChatRecording" ADD COLUMN "guard" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ChatRecording" ADD COLUMN "trashed" BOOLEAN NOT NULL DEFAULT false;

-- Flagged chats (by the team or the chat guard).
CREATE TABLE "ChatFlag" (
    "shop" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChatFlag_pkey" PRIMARY KEY ("shop","sessionId")
);
CREATE INDEX "ChatFlag_shop_createdAt_idx" ON "ChatFlag"("shop", "createdAt");

-- Chat guard state per chat and per address.
CREATE TABLE "ChatGuard" (
    "shop" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "strikes" INTEGER NOT NULL DEFAULT 0,
    "lastCategory" TEXT NOT NULL DEFAULT '',
    "lastStrikeAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChatGuard_pkey" PRIMARY KEY ("shop","key")
);
CREATE INDEX "ChatGuard_updatedAt_idx" ON "ChatGuard"("updatedAt");
