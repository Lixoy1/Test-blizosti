CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed'))
);

CREATE TABLE IF NOT EXISTS participants (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('A', 'B')),
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, role)
);

CREATE TABLE IF NOT EXISTS submissions (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('A', 'B')),
  answers JSONB NOT NULL,
  consent BOOLEAN NOT NULL CHECK (consent = TRUE),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, role)
);

CREATE INDEX IF NOT EXISTS idx_participants_token_hash ON participants(token_hash);
CREATE INDEX IF NOT EXISTS idx_submissions_room_id ON submissions(room_id);
