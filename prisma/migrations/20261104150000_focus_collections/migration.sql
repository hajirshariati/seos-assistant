-- The Collections section in the Focus Footwear and Orthotics sheets can be switched off.
ALTER TABLE "ShopConfig" ADD COLUMN "focusCollectionsOn" BOOLEAN NOT NULL DEFAULT true;
