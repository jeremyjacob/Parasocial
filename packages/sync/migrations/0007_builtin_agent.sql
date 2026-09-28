-- Built-in agent: runs inside the app server on the user's own model provider, and works notes
-- handed to it (one at a time per document) through the same tools and mutators as MCP agents.

-- server-only. One provider per user; the key is sealed with APP_SECRET (AES-GCM) and never
-- leaves the server.
CREATE TABLE user_agent_settings (
  user_id       text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google', 'openai-compatible')),
  model         text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  base_url      text,
  api_key_enc   text,                              -- base64(iv || ciphertext)
  api_key_hint  text,                              -- last 4 characters, for display
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Sessions the app runs itself (not an MCP connection).
ALTER TABLE agent_sessions ADD COLUMN builtin boolean NOT NULL DEFAULT false;

-- Handed to the built-in agent by this user (it runs on their provider). Kept until a human takes
-- the note back, so a follow-up reply puts the agent back to work. agent_assigned_at counts as
-- human activity: handing a note over again re-runs it.
ALTER TABLE notes ADD COLUMN agent_assigned_by text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE notes ADD COLUMN agent_assigned_at timestamptz;
