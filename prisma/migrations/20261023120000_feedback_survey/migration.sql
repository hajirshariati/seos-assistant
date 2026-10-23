-- The store's feedback survey (Typeform) as a Start here button in the chat,
-- and hiding the separate live chat button.
ALTER TABLE "ShopConfig" ADD COLUMN "feedbackSurveyOn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopConfig" ADD COLUMN "feedbackSurvey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "feedbackSurveyLabel" TEXT NOT NULL DEFAULT 'Share feedback';
ALTER TABLE "ShopConfig" ADD COLUMN "hideLiveChatButton" BOOLEAN NOT NULL DEFAULT false;
