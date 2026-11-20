-- A JSON flag's JSON Schema (jsonSchema.ts): every value it can serve (its variants and the values typed into its rules
-- and defaults) must match it. Null: no schema. Only JSON flags have one.
alter table flag add column json_schema jsonb null;
alter table flag add constraint flag_json_schema_json check (json_schema is null or value_type = 'json');
