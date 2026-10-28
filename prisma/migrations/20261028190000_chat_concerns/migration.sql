-- What shoppers keep asking about (Test recordings): themes found in
-- recorded shopper chats, and which chats raised each (kept after the
-- recordings expire, so the counts cover all time).
CREATE TABLE "ChatConcern" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'question',
    "lookAt" TEXT NOT NULL DEFAULT '',
    "describedAt" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConcern_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatConcernChat" (
    "shop" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "concernIds" TEXT[],
    "quoteIds" TEXT[],
    "lastTurnAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConcernChat_pkey" PRIMARY KEY ("shop","sessionId")
);

CREATE INDEX "ChatConcern_shop_idx" ON "ChatConcern"("shop");
