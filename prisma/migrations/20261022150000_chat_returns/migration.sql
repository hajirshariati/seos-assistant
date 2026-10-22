-- Returns started in the chat (order and line ids only).
CREATE TABLE "ChatReturn" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineIds" TEXT[],
    "reasonKey" TEXT NOT NULL,
    "methodKey" TEXT NOT NULL DEFAULT '',
    "methodLabel" TEXT NOT NULL DEFAULT '',
    "findUrl" TEXT NOT NULL DEFAULT '',
    "exchange" BOOLEAN NOT NULL DEFAULT false,
    "rma" TEXT NOT NULL DEFAULT '',
    "returnId" TEXT NOT NULL DEFAULT '',
    "labelUrl" TEXT NOT NULL DEFAULT '',
    "exchangeCards" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatReturn_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatReturn_shop_orderId_idx" ON "ChatReturn"("shop", "orderId");
CREATE INDEX "ChatReturn_createdAt_idx" ON "ChatReturn"("createdAt");
