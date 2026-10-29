-- AVA's activity in Shopify Analytics: on unless the store turns it off.
ALTER TABLE "ShopConfig" ADD COLUMN "appEventsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ShopConfig" ADD COLUMN "appEventsShop" TEXT NOT NULL DEFAULT '';
