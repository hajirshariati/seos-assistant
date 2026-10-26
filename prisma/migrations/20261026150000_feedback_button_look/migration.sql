-- The feedback button's tint and icon, and whether it leaves once sent.
ALTER TABLE "ShopConfig" ADD COLUMN "feedbackSurveyColor" TEXT NOT NULL DEFAULT 'teal';
ALTER TABLE "ShopConfig" ADD COLUMN "feedbackSurveyIcon" TEXT NOT NULL DEFAULT 'feedback';
ALTER TABLE "ShopConfig" ADD COLUMN "feedbackSurveyHideAfter" BOOLEAN NOT NULL DEFAULT true;
