-- Talk to a person: hours, phone, email, reply time. My rewards: the card.
ALTER TABLE "ShopConfig" ADD COLUMN "supportHours" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "supportPhone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "supportEmail" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "supportReplyTime" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "rewardsCard" TEXT NOT NULL DEFAULT '{}';

-- Customer service log, kept three years.
CREATE TABLE "ChatInteraction" (
    "shop" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "visitor" TEXT NOT NULL DEFAULT '',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "signedIn" BOOLEAN NOT NULL DEFAULT false,
    "humanOffered" BOOLEAN NOT NULL DEFAULT false,
    "humanActivated" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT NOT NULL DEFAULT '',
    "disclosureId" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "ChatInteraction_pkey" PRIMARY KEY ("shop","sessionId")
);
CREATE INDEX "ChatInteraction_shop_startedAt_idx" ON "ChatInteraction"("shop", "startedAt");
CREATE INDEX "ChatInteraction_startedAt_idx" ON "ChatInteraction"("startedAt");

CREATE TABLE "ChatDisclosure" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatDisclosure_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChatDisclosure_shop_text_key" ON "ChatDisclosure"("shop", "text");
