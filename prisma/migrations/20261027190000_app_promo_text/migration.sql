-- The app message's text and button, set in Settings ('' → the defaults).
ALTER TABLE "ShopConfig" ADD COLUMN "appPromoText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "appPromoButton" TEXT NOT NULL DEFAULT '';
