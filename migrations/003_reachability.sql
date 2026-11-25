ALTER TABLE pending_line ADD COLUMN reachable INTEGER NOT NULL DEFAULT 0 CHECK(reachable IN (0,1));
