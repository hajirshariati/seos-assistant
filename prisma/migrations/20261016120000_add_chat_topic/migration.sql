-- What storefront chat turns were about, for the Analytics weekly summary.
CREATE TABLE IF NOT EXISTS "ChatTopic" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatTopic_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ChatTopic_shop_createdAt_idx" ON "ChatTopic"("shop", "createdAt");
CREATE INDEX IF NOT EXISTS "ChatTopic_createdAt_idx" ON "ChatTopic"("createdAt");
