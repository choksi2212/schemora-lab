ALTER TABLE import_artifacts ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE imports ADD COLUMN parser_version text;
ALTER TABLE imports ADD COLUMN normalizer_schema integer;
ALTER TABLE imports ADD COLUMN extractor_version text;
ALTER TABLE imports ADD COLUMN provider_model text;
ALTER TABLE imports ADD COLUMN prompt_version text;
