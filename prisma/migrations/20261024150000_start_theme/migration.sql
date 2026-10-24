-- Which look the chat starts in (shoppers can still switch, and keep their pick).
ALTER TABLE "ShopConfig" ADD COLUMN "startTheme" TEXT NOT NULL DEFAULT 'dark';
