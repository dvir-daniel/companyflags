-- A request an agent proposed (with an agent's access token, tokens.ts) says so, in Approvals.
alter table change_set add column by_agent boolean not null default false;
