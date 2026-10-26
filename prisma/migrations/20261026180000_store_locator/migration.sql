-- The store locator (Storepoint) inside the chat.
ALTER TABLE "ShopConfig" ADD COLUMN "storeLocatorMapId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "storeLocatorLabel" TEXT NOT NULL DEFAULT 'Find a store near you';
ALTER TABLE "ShopConfig" ADD COLUMN "storeLocatorUrl" TEXT NOT NULL DEFAULT '';
