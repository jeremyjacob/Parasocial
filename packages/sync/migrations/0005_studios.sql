-- parts/ is now studios/: a studio script exports one or more parts. Moves existing scripts and
-- the script paths recorded in version snapshots, and re-points the path CHECK.
ALTER TABLE scripts DROP CONSTRAINT scripts_path_check;

UPDATE scripts SET path = 'studios/' || substr(path, length('parts/') + 1) WHERE path LIKE 'parts/%';

UPDATE versions SET snapshot = jsonb_set(snapshot, '{scripts}', (
  SELECT jsonb_object_agg(CASE WHEN k LIKE 'parts/%' THEN 'studios/' || substr(k, length('parts/') + 1) ELSE k END, v)
  FROM jsonb_each(snapshot->'scripts') AS e(k, v)
))
WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(snapshot->'scripts') AS k WHERE k LIKE 'parts/%');

ALTER TABLE scripts ADD CONSTRAINT scripts_path_check
  CHECK (path ~ '^(studios/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts|lib/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts)$');
