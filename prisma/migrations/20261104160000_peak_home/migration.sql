-- Peak Mode: the home on peak days (promotion blocks and the assistant's peak picture).
ALTER TABLE "ShopConfig" ADD COLUMN "peakHome" TEXT NOT NULL DEFAULT '{}';
