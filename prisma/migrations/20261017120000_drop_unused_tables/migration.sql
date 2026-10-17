-- Tables of removed features (old chat engine's fact index and claim
-- rules, social proof, customer-account login). Nothing reads or writes
-- them anymore; dropping them frees their disk space.
DROP TABLE IF EXISTS "CatalogFact" CASCADE;
DROP TABLE IF EXISTS "CatalogFacetIndex" CASCADE;
DROP TABLE IF EXISTS "ClaimRule" CASCADE;
DROP TABLE IF EXISTS "CategoryGroup" CASCADE;
DROP TABLE IF EXISTS "ColorFamily" CASCADE;
DROP TABLE IF EXISTS "ProductViewerPing" CASCADE;
DROP TABLE IF EXISTS "RecentPurchase" CASCADE;
DROP TABLE IF EXISTS "CustomerAccountToken" CASCADE;
