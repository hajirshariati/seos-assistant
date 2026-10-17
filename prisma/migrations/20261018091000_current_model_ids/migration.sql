-- Claude Sonnet 4 / Opus 4 (2025-05 snapshots) are deprecated and will be
-- retired; a store still on one would stop answering that day. Move them to
-- the current model of the same tier, and make the default match the schema.
ALTER TABLE "ShopConfig" ALTER COLUMN "anthropicModel" SET DEFAULT 'claude-sonnet-4-6';
UPDATE "ShopConfig" SET "anthropicModel" = 'claude-sonnet-4-6' WHERE "anthropicModel" IN ('claude-sonnet-4-20250514', 'claude-sonnet-4-0', '');
UPDATE "ShopConfig" SET "anthropicModel" = 'claude-opus-4-7' WHERE "anthropicModel" IN ('claude-opus-4-20250514', 'claude-opus-4-0');
