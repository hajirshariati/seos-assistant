-- The Focus home's Footwear and Orthotics card pictures ('' → a line drawing).
ALTER TABLE "ShopConfig" ADD COLUMN "focusFootwearImage" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "focusOrthoticsImage" TEXT NOT NULL DEFAULT '';
