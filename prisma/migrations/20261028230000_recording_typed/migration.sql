-- Test recordings: whether the shopper typed the message or a button sent
-- it (null for turns recorded before the widget said). The issues card reads
-- only what shoppers type, so the themes found so far — which also read
-- button messages — are cleared and every kept shopper chat is read again.
ALTER TABLE "ChatRecording" ADD COLUMN "typed" BOOLEAN;

DELETE FROM "ChatConcernChat";
DELETE FROM "ChatConcern";
