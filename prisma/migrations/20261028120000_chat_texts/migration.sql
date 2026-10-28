-- The chat's own words, set in Settings ('{}' → the theme editor's).
ALTER TABLE "ShopConfig" ADD COLUMN "chatTexts" TEXT NOT NULL DEFAULT '{}';
