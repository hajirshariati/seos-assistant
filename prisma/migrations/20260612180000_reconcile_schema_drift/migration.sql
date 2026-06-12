-- Reconcile schema.prisma with the migration history.
--
-- 17 columns and the AttributeMapping table existed in schema.prisma but in
-- no migration (the production database got them via `prisma db push`), so a
-- fresh database provisioned with `prisma migrate deploy` was missing them
-- and every ShopConfig/Product read crashed. Everything here is idempotent
-- (IF NOT EXISTS) so databases that already carry the columns are untouched.

-- ShopConfig
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "deduplicateColors" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "klaviyoPrivateKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "yotpoLoyaltyApiKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "yotpoLoyaltyGuid" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "loyaltyDisplay" TEXT NOT NULL DEFAULT 'points';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "loyaltyPointsPerDollar" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "loyaltyRounding" TEXT NOT NULL DEFAULT 'exact';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "hideOnUrls" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "categoryExclusions" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "trackingPageUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "returnsPageUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "referralPageUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "vipModeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "showLoginPill" BOOLEAN NOT NULL DEFAULT true;

-- Product
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "featuredImageUrl" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "attributesJson" JSONB;

-- ProductVariant
ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "attributesJson" JSONB;

-- AttributeMapping
CREATE TABLE IF NOT EXISTS "AttributeMapping" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "attribute" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT 'product',
    "namespace" TEXT,
    "key" TEXT,
    "prefix" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributeMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AttributeMapping_shop_attribute_key" ON "AttributeMapping"("shop", "attribute");
CREATE INDEX IF NOT EXISTS "AttributeMapping_shop_idx" ON "AttributeMapping"("shop");
