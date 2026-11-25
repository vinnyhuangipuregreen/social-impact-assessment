CREATE TABLE event_cadres (
  event_id TEXT NOT NULL REFERENCES events(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  assigned_by TEXT NOT NULL REFERENCES staff(id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY(event_id,participant_id)
);
