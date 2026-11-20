-- Migration 0020: the secrets this server keeps for other systems are stored sealed (server/sealed.ts): the CDN's
-- API token, and each webhook's signing secret and header values. They are sealed with a key derived from
-- BETTER_AUTH_SECRET, which the database doesn't have, so this file only makes room for them: the server seals the
-- rows saved before this version when it starts (sealStoredSecrets), in one transaction.
--
-- Rolling upgrades: a server of the version before keeps running against this schema. It reads a sealed value as it
-- is, so it can't purge the CDN or send webhooks until it is upgraded too (docs/self-hosting/upgrading.md).

-- A sealed token is longer than the token: the server checks the token's own length before sealing it (cdn.ts).
alter table cdn_setting drop constraint cdn_setting_api_token_check;
alter table cdn_setting add constraint cdn_setting_api_token_check check (length(api_token) between 20 and 400);
