-- Deals card on the Focus home.
ALTER TABLE "ShopConfig" ADD COLUMN "dealsCardOn" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ShopConfig" ADD COLUMN "dealsUrl" TEXT NOT NULL DEFAULT '';
