-- The code default a param had when it was first overridden, so the UI can say
-- "code default changed: 3 → 4" when the script's default moves underneath an override (PLAN §8).
ALTER TABLE param_overrides ADD COLUMN code_default text;
