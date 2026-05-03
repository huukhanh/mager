CREATE TABLE nodes (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  registered_at     INTEGER NOT NULL,
  last_seen         INTEGER,
  last_config_hash  TEXT,
  last_applied_at   INTEGER,
  status            TEXT DEFAULT 'unknown'
);

CREATE TABLE ingress_rules (
  node_id     TEXT NOT NULL,
  hostname    TEXT NOT NULL,
  service     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (node_id, hostname),
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  actor       TEXT,
  created_at  INTEGER NOT NULL
);
