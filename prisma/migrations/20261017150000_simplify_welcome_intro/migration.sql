-- The welcome intro is now a single on/off setting ("none" = off).
ALTER TABLE "ShopConfig" ALTER COLUMN "welcomeGlowStyle" SET DEFAULT 'subtle';
ALTER TABLE "ShopConfig" DROP COLUMN IF EXISTS "welcomeGlowColors",
  DROP COLUMN IF EXISTS "welcomeGlowBorderWidth",
  DROP COLUMN IF EXISTS "welcomeGlowSize",
  DROP COLUMN IF EXISTS "welcomeGlowFadeInMs",
  DROP COLUMN IF EXISTS "welcomeGlowHoldMs",
  DROP COLUMN IF EXISTS "welcomeGlowFadeOutMs",
  DROP COLUMN IF EXISTS "welcomeGlowSpeed";
