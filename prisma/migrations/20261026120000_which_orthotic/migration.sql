-- A Typeform that helps a shopper identify the orthotic they already own.
ALTER TABLE "ShopConfig" ADD COLUMN "whichOrthotic" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "whichOrthoticLabel" TEXT NOT NULL DEFAULT 'Identify my orthotic';
