-- Migration 0008: finding any change in history, however old (server/history.ts). History is kept forever, so each
-- filter of the History page has an index, and the newest matching entries are found without reading all the rest.

-- who made the change, newest first
create index change_history_by_person on change_history (changed_by, id desc);
-- what it changed (the subject of its kind: layer, flag, person, sso…), newest first
create index change_history_by_subject on change_history (split_part(change_type, '.', 1), id desc);
-- when
create index change_history_by_time on change_history (changed_at);
