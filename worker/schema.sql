-- Each row keeps the whole record as a JSON document in `doc`, with only the
-- columns the queue actually filters on lifted out beside it.
--
-- That shape is deliberate: the Express host stores these as plain objects and
-- patches them by merging, so keeping the document whole lets both hosts share
-- the same record shapes and the same tests. Lifting a few columns out is what
-- makes the queued-command lookup an index scan rather than a table read.

CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  pairing_code TEXT NOT NULL,
  status TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pairings_by_code ON pairings (pairing_code, status);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  control_token_hash TEXT,
  linked_at TEXT,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_by_token ON devices (control_token_hash);

CREATE TABLE IF NOT EXISTS subscriptions (
  device_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_runs (
  run_id TEXT PRIMARY KEY,
  updated_at TEXT,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS command_runs_by_updated ON command_runs (updated_at);

CREATE TABLE IF NOT EXISTS desktop_states (
  desktop_id TEXT PRIMARY KEY,
  last_seen_at TEXT,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_states_by_seen ON desktop_states (last_seen_at);

CREATE TABLE IF NOT EXISTS remote_commands (
  command_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  lane TEXT NOT NULL,
  target_desktop_id TEXT,
  created_at TEXT,
  doc TEXT NOT NULL
);
-- The hot path: "what is queued for this desktop on this lane, oldest first".
CREATE INDEX IF NOT EXISTS remote_commands_queue
  ON remote_commands (status, lane, target_desktop_id, created_at);

CREATE TABLE IF NOT EXISTS remote_command_inputs (
  command_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (command_id, sequence)
);
