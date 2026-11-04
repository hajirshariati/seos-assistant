-- Settings: the words of a reply shown as they are written (on by default).
ALTER TABLE "ShopConfig" ADD COLUMN "streamRepliesOn" BOOLEAN NOT NULL DEFAULT true;
