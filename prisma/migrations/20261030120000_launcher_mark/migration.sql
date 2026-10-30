-- What sits in the chat bar: AVA's light ("orb") or the avatar photo, the
-- minimized text button's words, and the photo the storefront last reported.
ALTER TABLE "ShopConfig" ADD COLUMN "launcherMark" TEXT NOT NULL DEFAULT 'orb';
ALTER TABLE "ShopConfig" ADD COLUMN "launcherText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopConfig" ADD COLUMN "widgetAvatarUrl" TEXT;
