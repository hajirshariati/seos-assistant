-- Order status without signing in: order number (or confirmation code) + email (on by default).
ALTER TABLE "ShopConfig" ADD COLUMN "guestOrderLookup" BOOLEAN NOT NULL DEFAULT true;
