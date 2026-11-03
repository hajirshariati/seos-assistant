-- Memory windows and the Returns & exchanges card.
ALTER TABLE "ShopConfig" ADD COLUMN "promoMemoryDays" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "ShopConfig" ADD COLUMN "styleMemoryDays" INTEGER NOT NULL DEFAULT 730;
ALTER TABLE "ShopConfig" ADD COLUMN "returnsCardOn" BOOLEAN NOT NULL DEFAULT true;

-- Memory: offers the store showed, with first/last seen and when they ended.
CREATE TABLE "PromoMemory" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'page',
    "text" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromoMemory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PromoMemory_shop_source_text_key" ON "PromoMemory"("shop", "source", "text");
CREATE INDEX "PromoMemory_shop_endedAt_idx" ON "PromoMemory"("shop", "endedAt");
CREATE INDEX "PromoMemory_endedAt_idx" ON "PromoMemory"("endedAt");

-- Memory: products that left the store (archived, draft or deleted).
CREATE TABLE "RetiredProduct" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "style" TEXT NOT NULL DEFAULT '',
    "productType" TEXT NOT NULL DEFAULT '',
    "gender" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT 'archived',
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedAt" TIMESTAMP(3),
    CONSTRAINT "RetiredProduct_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RetiredProduct_shop_shopifyId_key" ON "RetiredProduct"("shop", "shopifyId");
CREATE INDEX "RetiredProduct_shop_returnedAt_idx" ON "RetiredProduct"("shop", "returnedAt");
CREATE INDEX "RetiredProduct_retiredAt_idx" ON "RetiredProduct"("retiredAt");
