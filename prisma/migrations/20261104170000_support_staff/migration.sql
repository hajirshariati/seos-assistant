-- The customer service team: staff who see the Recordings page only.
ALTER TABLE "ShopConfig" ADD COLUMN "supportStaff" TEXT NOT NULL DEFAULT '[]';
