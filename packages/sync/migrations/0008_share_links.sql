-- View-only share links: anyone holding the token can open the document read-only (the model,
-- its studios' code and configurations; not notes, history or who's in it), signed in or not.
-- Null when link sharing is off; replacing the token revokes the old link.
ALTER TABLE documents ADD COLUMN share_token text UNIQUE;
