-- Fit confidence: which levels (High, Mid, Fair) show on product cards.
ALTER TABLE "ShopConfig" ADD COLUMN "fitConfidenceLevels" TEXT NOT NULL DEFAULT 'high,mid';
