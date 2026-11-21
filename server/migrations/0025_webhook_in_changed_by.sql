-- Migration 0025: who last changed an incoming webhook (its settings or its address). A request it makes is theirs (or
-- its creator's, while nobody has changed it), so they can't approve it themselves (webhooks.ts receive).
alter table webhook_in add column changed_by text;
