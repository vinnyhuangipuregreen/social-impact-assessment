CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE demo_delivery_receipts (
  key TEXT PRIMARY KEY, status TEXT NOT NULL, reference TEXT, accepted_at TEXT, tries INTEGER NOT NULL DEFAULT 0
);
