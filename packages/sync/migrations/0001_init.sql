-- Parasocial platform schema (M2).
--
-- Two kinds of tables live here:
--   * Synced tables: published to zero-cache via the `parasocial_zero` publication
--     at the bottom of this file. Clients only ever see rows that the synced
--     queries in src/queries.ts return, which all filter through document_members.
--   * Server-only tables: auth secrets, version contents, blobs, instance settings.
--     They are NOT in the publication, so zero-cache never replicates them.
--
-- Timestamps are timestamptz; Zero maps them to epoch milliseconds (number).

-- ───────────────────────────── accounts ─────────────────────────────

CREATE TABLE users (
  id           text PRIMARY KEY,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  avatar_seed  text NOT NULL,
  is_admin     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- server-only
CREATE TABLE passkeys (
  id              text PRIMARY KEY,               -- credential id, base64url
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key      bytea NOT NULL,                 -- COSE public key
  counter         bigint NOT NULL DEFAULT 0,
  transports      text[] NOT NULL DEFAULT '{}',
  device_type     text NOT NULL,                  -- singleDevice | multiDevice
  backed_up       boolean NOT NULL DEFAULT false,
  name            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);

-- server-only. The cookie carries a random token; only its sha256 is stored.
CREATE TABLE auth_sessions (
  id           text PRIMARY KEY,                  -- sha256(token), hex
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

-- server-only. Pending WebAuthn ceremonies (challenge bound to a cookie id).
CREATE TABLE webauthn_challenges (
  id           text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('register', 'login', 'add')),
  challenge    text NOT NULL,
  user_id      text,                              -- pre-generated id for register, owner for add
  name         text,                              -- requested display name for register
  invite_hash  text,
  expires_at   timestamptz NOT NULL
);

-- server-only. Single row.
CREATE TABLE instance_settings (
  id           int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  signup_mode  text NOT NULL DEFAULT 'open' CHECK (signup_mode IN ('open', 'invite')),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO instance_settings (id) VALUES (1);

-- server-only
CREATE TABLE invites (
  token_hash   text PRIMARY KEY,                  -- sha256(token), hex
  created_by   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  redeemed_by  text REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at  timestamptz
);

-- server-only (MCP OAuth 2.1, M5). Schema reserved now so M5 needs no reshuffle.
CREATE TABLE oauth_clients (
  id                    text PRIMARY KEY,         -- client_id
  client_name           text NOT NULL,
  redirect_uris         jsonb NOT NULL DEFAULT '[]',
  secret_hash           text,                     -- null for public (PKCE) clients
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_tokens (
  id                    text PRIMARY KEY,
  client_id             text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id               text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                  text NOT NULL CHECK (kind IN ('code', 'access', 'refresh')),
  token_hash            text NOT NULL UNIQUE,
  scope                 text NOT NULL DEFAULT '',
  code_challenge        text,
  document_id           text,                     -- default document for "Connect agent"
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  revoked_at            timestamptz
);
CREATE INDEX oauth_tokens_user_idx ON oauth_tokens(user_id);

-- ───────────────────────────── documents ─────────────────────────────

CREATE TABLE documents (
  id            text PRIMARY KEY,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  owner_id      text NOT NULL REFERENCES users(id),
  units         text NOT NULL DEFAULT 'mm',
  settings      jsonb NOT NULL DEFAULT '{}',
  head_version  integer NOT NULL DEFAULT 0,     -- number of the latest version
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_members (
  document_id  text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX document_members_user_idx ON document_members(user_id);

CREATE TABLE agent_sessions (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  oauth_client_id text REFERENCES oauth_clients(id) ON DELETE SET NULL,
  client_name     text NOT NULL,
  label           text,
  avatar_seed     text NOT NULL,
  status          text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'writing', 'disconnected')),
  document_id     text REFERENCES documents(id) ON DELETE SET NULL,
  detail          jsonb,                          -- e.g. { noteId, path }
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_sessions_user_idx ON agent_sessions(user_id);

CREATE TABLE scripts (
  id                  text PRIMARY KEY,
  document_id         text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  path                text NOT NULL,
  content             text NOT NULL,
  content_hash        text NOT NULL,              -- sha256 hex of content
  version             integer NOT NULL,           -- document version that last changed this script (baseVersion target)
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user     text REFERENCES users(id) ON DELETE SET NULL,
  updated_by_agent    text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  UNIQUE (document_id, path),
  CHECK (path ~ '^(parts/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts|lib/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ts)$')
);

CREATE TABLE versions (
  id                  text PRIMARY KEY,
  document_id         text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  number              integer NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('script', 'params', 'restore', 'import')),
  author_user_id      text REFERENCES users(id) ON DELETE SET NULL,
  author_agent_id     text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  message             text NOT NULL,
  note_id             text,                       -- note this version answers (no FK: notes may be removed)
  restored_from       text,                       -- version id, for restores
  snapshot            jsonb NOT NULL,             -- { scripts: {path: sha256}, params: {configurations: [...]} }
  changes             jsonb,                      -- params coalescing state
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, number)
);

-- server-only: version contents, content-addressed. Zero syncs version metadata only;
-- contents are fetched on demand (read_version) through a membership-checked endpoint.
CREATE TABLE script_contents (
  hash        text PRIMARY KEY,                  -- sha256 hex
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE configurations (
  id           text PRIMARY KEY,
  document_id  text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100 AND name <> 'Default'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, name)
);

CREATE TABLE param_overrides (
  id                text PRIMARY KEY,
  document_id       text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  configuration_id  text NOT NULL REFERENCES configurations(id) ON DELETE CASCADE,
  part              text NOT NULL,                -- part script path, e.g. parts/bracket.ts
  name              text NOT NULL,                -- param name
  expression        text NOT NULL,                -- as typed, e.g. "=width/2" or "1/4 in"
  value             jsonb NOT NULL,               -- evaluated value (number | string | boolean)
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (configuration_id, part, name)
);
CREATE INDEX param_overrides_doc_idx ON param_overrides(document_id);

CREATE TABLE notes (
  id                 text PRIMARY KEY,
  document_id        text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_user_id     text REFERENCES users(id) ON DELETE SET NULL,
  author_agent_id    text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  anchor             jsonb NOT NULL,              -- NoteAnchor (PLAN §6) minus markup (see markup_strokes)
  snapshot_hash      text,                        -- blob hash of the viewport capture (null only for imported notes)
  status             text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'AgentWorking', 'AwaitingReview', 'Resolved')),
  orphaned           boolean NOT NULL DEFAULT false,
  claimed_by         text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  removed_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_doc_idx ON notes(document_id);

CREATE TABLE note_messages (
  id                 text PRIMARY KEY,
  note_id            text NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  document_id        text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_user_id     text REFERENCES users(id) ON DELETE SET NULL,
  author_agent_id    text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  kind               text NOT NULL CHECK (kind IN ('message', 'activity')),
  text               text NOT NULL DEFAULT '',
  data               jsonb,                       -- activity payload: { action: 'render' | 'measure' | 'write' ..., ... }
  version_id         text,                        -- linked version (agent replies)
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX note_messages_note_idx ON note_messages(note_id);

CREATE TABLE markup_strokes (
  id                 text PRIMARY KEY,
  document_id        text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  note_id            text REFERENCES notes(id) ON DELETE CASCADE,  -- null while drafting
  author_user_id     text REFERENCES users(id) ON DELETE SET NULL,
  part               text NOT NULL,
  points             jsonb NOT NULL,              -- part-local [[x,y,z], ...]
  color              text NOT NULL,
  width              real NOT NULL DEFAULT 2,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX markup_strokes_doc_idx ON markup_strokes(document_id);

-- Ephemeral presence: one row per browser tab or agent session per document.
CREATE TABLE presence (
  id                       text PRIMARY KEY,
  document_id              text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id                  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_session_id         text REFERENCES agent_sessions(id) ON DELETE CASCADE,
  selection                jsonb NOT NULL DEFAULT '[]',
  active_configuration_id  text,                  -- null = Default
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX presence_doc_idx ON presence(document_id);

-- server-only: authored binaries (note snapshots). Content-addressed.
CREATE TABLE blobs (
  hash          text PRIMARY KEY,                -- sha256 hex
  size          bigint NOT NULL,
  content_type  text NOT NULL,
  refcount      integer NOT NULL DEFAULT 0,
  uploaded_by   text REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── replication ─────────────────────────────
-- Only these tables reach zero-cache. Set ZERO_APP_PUBLICATIONS=parasocial_zero.
CREATE PUBLICATION parasocial_zero FOR TABLE
  users, documents, document_members, agent_sessions, scripts, versions,
  configurations, param_overrides, notes, note_messages, markup_strokes, presence;
