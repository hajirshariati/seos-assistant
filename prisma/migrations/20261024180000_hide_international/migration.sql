-- Hide the chat for shoppers outside the store's home countries (on by default).
ALTER TABLE "ShopConfig" ADD COLUMN "hideInternational" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ShopConfig" ADD COLUMN "homeCountries" TEXT NOT NULL DEFAULT 'US';
