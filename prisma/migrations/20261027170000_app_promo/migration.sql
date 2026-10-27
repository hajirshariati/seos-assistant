-- A quiet mention of the store's mobile app in the chat (on by default; links optional).
ALTER TABLE "ShopConfig" ADD COLUMN "appPromoOn" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ShopConfig" ADD COLUMN "appIosUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "appAndroidUrl" TEXT NOT NULL DEFAULT '';
