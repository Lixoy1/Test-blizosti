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
  current_version_no INTEGER NOT NULL DEFAULT 1,
  consented_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, role)
);

ALTER TABLE participants ADD COLUMN IF NOT EXISTS current_version_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS intimacy_consented_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS submissions (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('A', 'B')),
  version_no INTEGER NOT NULL DEFAULT 1,
  answers JSONB NOT NULL,
  consent BOOLEAN NOT NULL CHECK (consent = TRUE),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS version_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_room_id_role_key;
CREATE UNIQUE INDEX IF NOT EXISTS submissions_room_role_version_uidx
  ON submissions(room_id, role, version_no);

CREATE TABLE IF NOT EXISTS drafts (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('A', 'B')),
  version_no INTEGER NOT NULL,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, role, version_no)
);

CREATE TABLE IF NOT EXISTS answer_history (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('A', 'B')),
  version_no INTEGER NOT NULL,
  question_id INTEGER NOT NULL CHECK (question_id BETWEEN 1 AND 125),
  old_value JSONB,
  new_value JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_participants_token_hash ON participants(token_hash);
CREATE INDEX IF NOT EXISTS idx_submissions_room_id ON submissions(room_id);
CREATE INDEX IF NOT EXISTS idx_submissions_room_role_version ON submissions(room_id, role, version_no DESC);
CREATE INDEX IF NOT EXISTS idx_answer_history_room_role_version ON answer_history(room_id, role, version_no, changed_at);

-- The adult intimacy module has an independent consent, draft and submission lifecycle.
CREATE TABLE IF NOT EXISTS intimacy_drafts (
  room_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('A', 'B')),
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, role),
  FOREIGN KEY (room_id, role) REFERENCES participants(room_id, role) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS intimacy_submissions (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('A', 'B')),
  answers JSONB NOT NULL,
  consent BOOLEAN NOT NULL CHECK (consent = TRUE),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, role),
  FOREIGN KEY (room_id, role) REFERENCES participants(room_id, role) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_intimacy_submissions_room
  ON intimacy_submissions(room_id, role);
