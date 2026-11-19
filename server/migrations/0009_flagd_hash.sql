-- Migration 0009: every % of devices moves to hash version 2, flagd's (server/hash.ts).
--
-- Backends can now download their flags as flagd JSON (server/flagd.ts, GET /sdk/v1/flagd) and evaluate them with
-- flagd or an OpenFeature flagd provider. flagd puts a device in a % with its own hash; version 2 is that hash, so the
-- server, the apps' files and flagd all put each device in the same group. Version 1 can't be written as flagd JSON.
--
-- This moves devices once: a device inside a 20% before may be outside it after (still about 20% in all). Rules
-- saved from now on get version 2 (checks.ts), including older versions being restored.
alter table flag_rule drop constraint flag_rule_hash_version_check;
update flag_rule set split_hash_version = 2 where split_hash_version is not null;
-- the update leaves flag_rule's deferred checks (rule positions, overrides first) pending, and Postgres won't alter
-- a table with pending checks: run them now
set constraints all immediate;
alter table flag_rule add constraint flag_rule_hash_version_check check (split_hash_version is null or split_hash_version = 2);
