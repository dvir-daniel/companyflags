-- Migration 0006: indexes for the queries that run on every page load or every second.

-- History: a version's changes, rolling back (environment + revision), a flag's or a customer's history (newest first)
create index change_history_by_revision on change_history (environment_id, revision);
create index change_history_by_flag on change_history (flag, id desc);
create index change_history_by_customer on change_history (customer, id desc);

-- people and their accounts meet on the email (app_user.key = lower(auth_user.email))
create index auth_user_lower_email on auth_user (lower(email));
-- Better Auth finds a provider sign-in by provider and account id; removing an SSO connection finds its accounts
create index auth_account_provider on auth_account (provider_id, account_id);

-- the scheduler looks for due requests every second; the queue lists them by status
create index change_set_scheduled on change_set (scheduled_at) where status = 'scheduled';
create index change_set_by_status on change_set (status);

-- a snapshot loads one environment's layers and deliveries (the unique keys lead with the flag)
create index flag_layer_by_environment on flag_layer (environment_id);
create index flag_delivery_by_environment on flag_delivery (environment_id);
