-- Tempus Social (friends) database. Apply once:
--   npx wrangler d1 execute tempus-social --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS players (
  uuid        TEXT PRIMARY KEY,          -- hyphenated, lowercase
  name        TEXT NOT NULL,
  name_lc     TEXT NOT NULL,
  key_hash    TEXT,                      -- SHA-256 of the player's private key; NULL until they first open Social
  created     INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS players_name_lc ON players(name_lc);

CREATE TABLE IF NOT EXISTS friends (     -- stored in both directions
  a      TEXT NOT NULL,
  b      TEXT NOT NULL,
  since  INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);

CREATE TABLE IF NOT EXISTS requests (
  from_uuid  TEXT NOT NULL,
  to_uuid    TEXT NOT NULL,
  created    INTEGER NOT NULL,
  PRIMARY KEY (from_uuid, to_uuid)
);
CREATE INDEX IF NOT EXISTS requests_to ON requests(to_uuid);
