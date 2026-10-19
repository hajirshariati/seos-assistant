-- Settings → Appearance: the assistant's theme on the storefront.
ALTER TABLE "ShopConfig" ADD COLUMN "widgetTheme" TEXT NOT NULL DEFAULT 'light';
