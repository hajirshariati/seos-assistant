-- Return rules mirrored from AfterShip Returns.
ALTER TABLE "ShopConfig" ADD COLUMN "returnRules" TEXT NOT NULL DEFAULT '{}';
