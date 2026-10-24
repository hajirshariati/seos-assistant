-- The store's promotions page, read live for the assistant: its link, and the
-- line where the promotions end (everything above it is the current offers).
ALTER TABLE "ShopConfig" ADD COLUMN "promoPageUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "promoPageStop" TEXT NOT NULL DEFAULT '';
