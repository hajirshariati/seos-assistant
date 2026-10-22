-- Which orders the chat offers a return on.
ALTER TABLE "ShopConfig" ADD COLUMN "returnWindowDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "ShopConfig" ADD COLUMN "returnsDeliveredOnly" BOOLEAN NOT NULL DEFAULT true;
