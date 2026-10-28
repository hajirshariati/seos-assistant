-- Top shopper issues & questions now leaves everyday browsing ("show me
-- shoes") out of the themes. Themes found under the earlier rules are
-- cleared, so every kept shopper chat is read again under the new ones (the
-- feature is new: all the chats it read are still kept).
DELETE FROM "ChatConcernChat";
DELETE FROM "ChatConcern";
