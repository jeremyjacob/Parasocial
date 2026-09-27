-- Rendered thumbnails for the documents list: blob hashes of an iso render in each theme, and the
-- document version they show (the workspace re-renders when head_version moves past it).
ALTER TABLE documents
  ADD COLUMN thumb_light   text,
  ADD COLUMN thumb_dark    text,
  ADD COLUMN thumb_version integer;
