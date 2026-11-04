-- Learn → Improve the website: site changes drafted from what shoppers said.
CREATE TABLE "SiteIdea" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "area" TEXT NOT NULL DEFAULT 'other',
    "change" TEXT NOT NULL,
    "why" TEXT NOT NULL DEFAULT '',
    "evidence" TEXT[],
    "impact" TEXT NOT NULL DEFAULT 'medium',
    "effort" TEXT NOT NULL DEFAULT 'medium',
    "shoppers" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    CONSTRAINT "SiteIdea_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SiteIdea_shop_status_idx" ON "SiteIdea"("shop", "status");
CREATE INDEX "SiteIdea_shop_createdAt_idx" ON "SiteIdea"("shop", "createdAt");
