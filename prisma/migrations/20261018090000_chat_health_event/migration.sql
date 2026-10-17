-- CreateTable
CREATE TABLE "ChatHealthEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "route" TEXT NOT NULL DEFAULT 'chat',
    "ok" BOOLEAN NOT NULL,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "errorKind" TEXT,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatHealthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatHealthEvent_shop_createdAt_idx" ON "ChatHealthEvent"("shop", "createdAt");

