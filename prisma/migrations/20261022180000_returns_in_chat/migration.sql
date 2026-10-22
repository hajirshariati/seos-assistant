-- Returns and exchanges inside the chat (on by default).
ALTER TABLE "ShopConfig" ADD COLUMN "returnsInChat" BOOLEAN NOT NULL DEFAULT true;
