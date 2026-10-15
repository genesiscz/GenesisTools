-- tools du index: SQLite schema version 1 (migration scope du_index).
-- meta keys: schema_version, tool_version, created_at_ms, root, volume_fsid, private ('1' or '0'),
--   min_dir_bytes, big_file_floor, snapshot_floor, excludes (JSON array), include_cloud ('1' or '0'),
--   last_build_scan_id, last_update_scan_id,
--   fsevents_device_uuid, fsevents_last_id (the last two are written by the app, optional).
-- dirs.flags bits: 1 denied, 2 incomplete listing, 4 cloud root skipped, 8 mount skipped, 16 gone (tombstone),
--   32 blocked (no progress for --stall-seconds, usually a macOS privacy prompt; its totals are missing).
-- dirs.parent_id is 0 for the root row (no row has id 0); a root row's name is its absolute path.
-- Times are epoch ms (or s where the column says _s). Sizes are bytes.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE scans (
  id             INTEGER PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('build', 'update')),
  root           TEXT    NOT NULL,
  started_at_ms  INTEGER NOT NULL,
  finished_at_ms INTEGER,
  status         TEXT    NOT NULL CHECK (status IN ('running', 'done', 'failed', 'aborted')),
  files          INTEGER,
  dirs           INTEGER,
  alloc_bytes    INTEGER,
  logical_bytes  INTEGER,
  private_bytes  INTEGER,
  denied_dirs    INTEGER,
  vanished_dirs  INTEGER,
  read_errors    INTEGER,
  walk_ms        INTEGER,
  threads        INTEGER,
  pid            INTEGER,
  options_json   TEXT    NOT NULL
);

CREATE TABLE dirs (
  id             INTEGER PRIMARY KEY,
  parent_id      INTEGER NOT NULL,
  name           TEXT    NOT NULL,
  fileid         INTEGER NOT NULL,
  alloc_bytes    INTEGER NOT NULL,
  logical_bytes  INTEGER NOT NULL,
  private_bytes  INTEGER,
  files          INTEGER NOT NULL,
  dirs           INTEGER NOT NULL,
  max_file_bytes INTEGER NOT NULL,
  newest_mtime_s INTEGER NOT NULL,
  dir_mtime_ms   INTEGER NOT NULL,
  flags          INTEGER NOT NULL DEFAULT 0,
  scan_id        INTEGER NOT NULL,
  first_scan_id  INTEGER NOT NULL
);

CREATE UNIQUE INDEX dirs_by_name ON dirs (parent_id, name);

CREATE INDEX dirs_by_size ON dirs (parent_id, alloc_bytes DESC);

CREATE TABLE big_files (
  path          TEXT PRIMARY KEY,
  dir_id        INTEGER NOT NULL,
  logical_bytes INTEGER NOT NULL,
  alloc_bytes   INTEGER NOT NULL,
  fileid        INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  nlink         INTEGER NOT NULL,
  scan_id       INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX big_files_by_size ON big_files (alloc_bytes DESC);

CREATE INDEX big_files_by_dir ON big_files (dir_id);

CREATE TABLE snapshots (
  id          INTEGER PRIMARY KEY,
  taken_at_ms INTEGER NOT NULL,
  root        TEXT    NOT NULL,
  alloc_bytes INTEGER NOT NULL,
  files       INTEGER NOT NULL,
  floor_bytes INTEGER NOT NULL
);

CREATE TABLE snapshot_dirs (
  snapshot_id   INTEGER NOT NULL,
  dir_id        INTEGER NOT NULL,
  alloc_bytes   INTEGER NOT NULL,
  logical_bytes INTEGER NOT NULL,
  files         INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, dir_id)
) WITHOUT ROWID;

CREATE INDEX snapshot_dirs_by_dir ON snapshot_dirs (dir_id);

CREATE TABLE dirty_queue (
  path         TEXT PRIMARY KEY,
  shallow      INTEGER NOT NULL DEFAULT 0,
  queued_at_ms INTEGER NOT NULL
) WITHOUT ROWID;
