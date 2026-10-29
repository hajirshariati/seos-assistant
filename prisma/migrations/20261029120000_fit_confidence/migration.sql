-- Fit confidence on product cards: the switch (on), the score and what it was
-- read from per store, and the store's AfterShip return items by reason.
ALTER TABLE "ShopConfig" ADD COLUMN "fitConfidenceEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "FitData" (
    "shop" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "status" JSONB,
    "readAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FitData_pkey" PRIMARY KEY ("shop")
);

CREATE TABLE "FitReturnItem" (
    "shop" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "returnedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FitReturnItem_pkey" PRIMARY KEY ("shop","id")
);

CREATE INDEX "FitReturnItem_shop_returnedAt_idx" ON "FitReturnItem"("shop", "returnedAt");
