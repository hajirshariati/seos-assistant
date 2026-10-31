-- Lessons from thumbs-down: drafted daily, decided by the store team.
CREATE TABLE "FeedbackLesson" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "lesson" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'behaviour',
    "fix" TEXT NOT NULL DEFAULT '',
    "examples" TEXT[],
    "feedbackIds" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "FeedbackLesson_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FeedbackLesson_shop_status_idx" ON "FeedbackLesson"("shop", "status");
CREATE INDEX "FeedbackLesson_shop_createdAt_idx" ON "FeedbackLesson"("shop", "createdAt");
