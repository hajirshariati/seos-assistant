-- Conversation recording for testing.
ALTER TABLE "ShopConfig" ADD COLUMN "recordChatsUntil" TIMESTAMP(3);
ALTER TABLE "ShopConfig" ADD COLUMN "recordChatsScope" TEXT NOT NULL DEFAULT 'testers';

CREATE TABLE "ChatRecording" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tester" TEXT NOT NULL DEFAULT '',
    "page" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL,
    "reply" TEXT NOT NULL,
    "products" TEXT[],
    "extras" TEXT NOT NULL DEFAULT '',
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRecording_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatRecording_shop_createdAt_idx" ON "ChatRecording"("shop", "createdAt");
CREATE INDEX "ChatRecording_shop_sessionId_idx" ON "ChatRecording"("shop", "sessionId");
CREATE INDEX "ChatRecording_createdAt_idx" ON "ChatRecording"("createdAt");
