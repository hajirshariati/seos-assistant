-- "How's the chat going?": a quiet check-in after a few replies.
ALTER TABLE "ShopConfig" ADD COLUMN "chatRatingOn" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ShopConfig" ADD COLUMN "chatRatingAfter" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "ChatFeedback" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'answer';
ALTER TABLE "ChatFeedback" ADD COLUMN "comment" TEXT;
CREATE INDEX "ChatFeedback_shop_sessionId_idx" ON "ChatFeedback"("shop", "sessionId");
