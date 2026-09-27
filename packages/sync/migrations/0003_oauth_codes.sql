-- OAuth 2.1 (MCP authorization): bind codes/tokens to the redirect URI and resource they were
-- issued for, and keep the refresh-token family so rotation can revoke a stolen chain.
ALTER TABLE oauth_tokens ADD COLUMN redirect_uri text;
ALTER TABLE oauth_tokens ADD COLUMN resource text;
ALTER TABLE oauth_tokens ADD COLUMN family text;
CREATE INDEX oauth_tokens_family_idx ON oauth_tokens(family);
