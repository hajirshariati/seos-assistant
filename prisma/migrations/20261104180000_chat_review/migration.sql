-- Lessons from the chat review as well as from thumbs-down.
ALTER TABLE "FeedbackLesson" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'feedback';

-- Chat review: how far the daily read of every recorded chat got.
CREATE TABLE "ChatReviewState" (
    "shop" TEXT NOT NULL,
    "reviewedThrough" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "chats" INTEGER NOT NULL DEFAULT 0,
    "findings" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChatReviewState_pkey" PRIMARY KEY ("shop")
);

-- Chat review: the answers it flagged.
CREATE TABLE "ChatReviewFinding" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "tester" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "better" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL,
    "reply" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatReviewFinding_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ChatReviewFinding_shop_createdAt_idx" ON "ChatReviewFinding"("shop", "createdAt");
