-- builds/: build scripts (how an assembly goes together, step by step) live next to studios/ and
-- lib/. Flat, like studios/.
ALTER TABLE scripts DROP CONSTRAINT scripts_path_check;

ALTER TABLE scripts ADD CONSTRAINT scripts_path_check
  CHECK (path ~ '^(studios/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts|builds/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts|lib/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts)$');
