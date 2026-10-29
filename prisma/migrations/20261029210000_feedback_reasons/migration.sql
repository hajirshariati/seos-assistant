-- Why a thumbs-down, when it was asked, and the widget's id for one vote.
ALTER TABLE "ChatFeedback" ADD COLUMN "reason" TEXT;
ALTER TABLE "ChatFeedback" ADD COLUMN "moment" TEXT;
ALTER TABLE "ChatFeedback" ADD COLUMN "clientKey" TEXT;

-- What the stores on the store locator map are: "retail" or "scanner".
ALTER TABLE "ShopConfig" ADD COLUMN "storeLocatorStores" TEXT NOT NULL DEFAULT 'retail';
