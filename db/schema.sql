-- Nexl AI database schema (PostgreSQL 13+)
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- intent, sources, engine, latency_ms ...
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, id);

-- Long-term memory: facts the user asked Nexl to remember.
CREATE TABLE IF NOT EXISTS memories (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fact       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories (user_id, id DESC);

-- Weighted search vector for a KB article. Declared IMMUTABLE (it only touches plain
-- text/text[] with a fixed 'english' config) so it can be used in a generated column.
CREATE OR REPLACE FUNCTION kb_tsv(title TEXT, tags TEXT[], body TEXT) RETURNS TSVECTOR AS $$
  SELECT setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
         setweight(to_tsvector('english'::regconfig, coalesce(array_to_string(tags, ' '), '')), 'B') ||
         setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'C')
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- Knowledge base searched by the Nexl engine (Postgres full-text search).
CREATE TABLE IF NOT EXISTS kb_articles (
  id    SERIAL PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  body  TEXT NOT NULL,
  tags  TEXT[] NOT NULL DEFAULT '{}',
  tsv   TSVECTOR GENERATED ALWAYS AS (kb_tsv(title, tags, body)) STORED
);
CREATE INDEX IF NOT EXISTS idx_kb_tsv ON kb_articles USING GIN (tsv);

-- Thumbs up / down feedback on assistant replies.
CREATE TABLE IF NOT EXISTS feedback (
  id         BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);
