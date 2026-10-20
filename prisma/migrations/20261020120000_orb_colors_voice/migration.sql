-- Settings → Assistant look: the mark's colors, and the talk button.
ALTER TABLE "ShopConfig" ADD COLUMN "orbColors" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "voiceInput" BOOLEAN NOT NULL DEFAULT true;
