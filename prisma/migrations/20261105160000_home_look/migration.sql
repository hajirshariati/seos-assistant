-- Settings → Focus home → Her look: the colours, ring, lights, tint and the
-- mini home on every other day (one JSON; "{}" = her built-in look).
ALTER TABLE "ShopConfig" ADD COLUMN "homeLook" TEXT NOT NULL DEFAULT '{}';
