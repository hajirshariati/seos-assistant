-- Show the chat on the page after a set delay (off: it shows right away).
ALTER TABLE "ShopConfig" ADD COLUMN "appearDelayOn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopConfig" ADD COLUMN "appearDelaySec" INTEGER NOT NULL DEFAULT 3;
