-- The seasonal button (Settings → Seasonal button).
ALTER TABLE "ShopConfig" ADD COLUMN "seasonalCtaOn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopConfig" ADD COLUMN "seasonalCtaIcon" TEXT NOT NULL DEFAULT 'fall';
ALTER TABLE "ShopConfig" ADD COLUMN "seasonalCtaColor" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "ShopConfig" ADD COLUMN "seasonalCtaLabel" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "seasonalCtaCollection" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "seasonalCtaCollectionTitle" TEXT NOT NULL DEFAULT '';
