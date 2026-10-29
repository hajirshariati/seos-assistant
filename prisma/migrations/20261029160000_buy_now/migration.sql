-- Buy now on the chat's product cards: the switch (off) and the discount code
-- it applies at checkout ("" = none).
ALTER TABLE "ShopConfig" ADD COLUMN "buyNowEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopConfig" ADD COLUMN "buyNowCode" TEXT NOT NULL DEFAULT '';
