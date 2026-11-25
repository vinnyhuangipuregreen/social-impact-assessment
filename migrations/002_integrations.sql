CREATE TABLE pending_line (
  token_hash TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject_encrypted TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE throttles (
  bucket TEXT PRIMARY KEY, times INTEGER NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX profile_card_lookup ON profiles(card_lookup);
