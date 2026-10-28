-- The store's product spec sheet (Catalog → Product specs), cleaned up: one
-- row per style code, matched to products when the catalog loads.
CREATE TABLE "ProductSpecSheet" (
    "shop"       TEXT NOT NULL,
    "fileName"   TEXT NOT NULL,
    "rowsJson"   TEXT NOT NULL,
    "reportJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSpecSheet_pkey" PRIMARY KEY ("shop")
);
