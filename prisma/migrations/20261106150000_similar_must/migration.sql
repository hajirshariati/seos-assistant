-- Catalog → "Show me something similar" → Must match: the ticked fields a
-- similar style must share outright (JSON list of field names).
ALTER TABLE "ShopConfig" ADD COLUMN "similarMustAttributes" TEXT NOT NULL DEFAULT '[]';
