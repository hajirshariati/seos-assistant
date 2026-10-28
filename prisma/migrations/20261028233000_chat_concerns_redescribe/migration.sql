-- Top shopper issues & questions: descriptions are now whole sentences (no
-- longer cut mid-word) and never point at chats by number. Every theme is
-- described again on the next read.
UPDATE "ChatConcern" SET "describedAt" = 0;
