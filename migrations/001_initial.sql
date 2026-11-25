CREATE TABLE org_units (
  id TEXT PRIMARY KEY, parent_id TEXT REFERENCES org_units(id),
  kind TEXT NOT NULL CHECK(kind IN ('district','chapter')), name TEXT NOT NULL
);
CREATE TABLE programs (code TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, metric TEXT NOT NULL, unit TEXT NOT NULL);
CREATE TABLE participants (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  merged_into_id TEXT REFERENCES participants(id)
);
CREATE TABLE identities (
  id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id),
  kind TEXT NOT NULL, issuer TEXT NOT NULL, lookup TEXT NOT NULL, encrypted TEXT NOT NULL,
  mask TEXT NOT NULL, verified_at TEXT NOT NULL, revoked_at TEXT
);
CREATE UNIQUE INDEX identity_current ON identities(kind, issuer, lookup) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX identity_by_owner ON identities(participant_id,kind,issuer) WHERE revoked_at IS NULL;
CREATE TABLE assets (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, purpose TEXT NOT NULL,
  mime TEXT NOT NULL, digest TEXT NOT NULL, content BLOB NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE profiles (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id), name TEXT NOT NULL DEFAULT '',
  member_status TEXT NOT NULL DEFAULT 'nonmember' CHECK(member_status IN ('nonmember','pending','verified','rejected')),
  district_id TEXT REFERENCES org_units(id), chapter_id TEXT REFERENCES org_units(id), region TEXT NOT NULL DEFAULT '',
  card_lookup TEXT, card_encrypted TEXT, card_mask TEXT, review_reason TEXT, photo_id TEXT REFERENCES assets(id),
  line_reachable INTEGER NOT NULL DEFAULT 0 CHECK(line_reachable IN (0,1))
);
CREATE UNIQUE INDEX verified_card ON profiles(card_lookup) WHERE member_status='verified';
CREATE TABLE consents (
  seq INTEGER PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id),
  purpose TEXT NOT NULL, scope TEXT NOT NULL, notice_version TEXT NOT NULL, choice INTEGER NOT NULL CHECK(choice IN (0,1)),
  created_at TEXT NOT NULL, source TEXT NOT NULL
);
CREATE INDEX consent_lookup ON consents(participant_id,purpose,scope,seq DESC);
CREATE TABLE challenges (
  id TEXT PRIMARY KEY, lookup TEXT NOT NULL, encrypted TEXT NOT NULL, mask TEXT NOT NULL,
  proof TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
  tries INTEGER NOT NULL DEFAULT 0, purpose TEXT NOT NULL, owner_id TEXT REFERENCES participants(id)
);
CREATE INDEX challenge_rate ON challenges(lookup,created_at);
CREATE TABLE staff (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, role TEXT NOT NULL, org_id TEXT REFERENCES org_units(id)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, participant_id TEXT REFERENCES participants(id), staff_id TEXT REFERENCES staff(id),
  expires_at TEXT NOT NULL, verified_at TEXT NOT NULL, CHECK ((participant_id IS NULL) <> (staff_id IS NULL))
);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT REFERENCES participants(id),
  expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE identity_cases (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, participant_id TEXT NOT NULL REFERENCES participants(id),
  other_id TEXT REFERENCES participants(id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, requested_by TEXT, reviewed_by TEXT, resolution TEXT
);
CREATE TABLE rights_requests (
  id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id), kind TEXT NOT NULL,
  note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received', created_at TEXT NOT NULL, reviewed_at TEXT
);
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY, created_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', request_id TEXT
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, program TEXT NOT NULL REFERENCES programs(code), title TEXT NOT NULL,
  region TEXT NOT NULL, venue TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES org_units(id),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, timezone TEXT NOT NULL,
  registration_opens TEXT NOT NULL, registration_closes TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','published','completed','archived','cancelled')),
  anchor_type TEXT NOT NULL DEFAULT 'event_end', created_at TEXT NOT NULL
);
CREATE INDEX event_scope ON events(org_id,status,starts_at);
CREATE TABLE enrollments (
  event_id TEXT NOT NULL REFERENCES events(id), participant_id TEXT NOT NULL REFERENCES participants(id),
  status TEXT NOT NULL CHECK(status IN ('registered','attended','cancelled')), registered_at TEXT NOT NULL,
  attended_at TEXT, anchor_at TEXT, PRIMARY KEY(event_id,participant_id)
);
CREATE INDEX enrollment_status ON enrollments(event_id,status);
CREATE TABLE survey_versions (
  id TEXT PRIMARY KEY, program TEXT NOT NULL REFERENCES programs(code), stage TEXT NOT NULL,
  version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','published','retired')),
  schema_json TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT,
  UNIQUE(program,stage,version)
);
CREATE TABLE event_surveys (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), stage TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES survey_versions(id), opens_at TEXT NOT NULL, closes_at TEXT NOT NULL,
  window_rule TEXT NOT NULL DEFAULT 'fixed', UNIQUE(event_id,stage)
);
CREATE TABLE responses (
  id TEXT PRIMARY KEY, event_survey_id TEXT NOT NULL REFERENCES event_surveys(id),
  participant_id TEXT NOT NULL REFERENCES participants(id), version_id TEXT NOT NULL REFERENCES survey_versions(id),
  answers_json TEXT NOT NULL, submitted_at TEXT NOT NULL, effective INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1, replaces_id TEXT REFERENCES responses(id)
);
CREATE UNIQUE INDEX effective_response ON responses(event_survey_id,participant_id) WHERE effective=1;
CREATE INDEX response_time ON responses(event_survey_id,submitted_at);
CREATE TABLE response_reviews (
  id TEXT PRIMARY KEY, response_id TEXT NOT NULL REFERENCES responses(id), answers_json TEXT NOT NULL, reason TEXT NOT NULL,
  created_at TEXT NOT NULL, by_staff TEXT NOT NULL REFERENCES staff(id), reviewed_by TEXT REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE previews (
  id TEXT PRIMARY KEY, survey_id TEXT NOT NULL REFERENCES event_surveys(id), staff_id TEXT NOT NULL REFERENCES staff(id),
  snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, preview_id TEXT UNIQUE NOT NULL REFERENCES previews(id), survey_id TEXT NOT NULL REFERENCES event_surveys(id),
  created_by TEXT NOT NULL REFERENCES staff(id), status TEXT NOT NULL, due_at TEXT NOT NULL,
  created_at TEXT NOT NULL, request_id TEXT
);
CREATE INDEX job_due ON jobs(status,due_at);
CREATE TABLE recipients (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  participant_id TEXT NOT NULL REFERENCES participants(id), UNIQUE(job_id,participant_id)
);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES recipients(id), number INTEGER NOT NULL,
  due_at TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, queued_at TEXT NOT NULL,
  accepted_at TEXT, provider_ref TEXT, retries INTEGER NOT NULL DEFAULT 0,
  UNIQUE(recipient_id,number)
);
CREATE INDEX attempt_queue ON attempts(status,due_at);
CREATE TABLE invitations (
  token_hash TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES recipients(id),
  expires_at TEXT NOT NULL, opened_at TEXT
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), title TEXT NOT NULL,
  source TEXT NOT NULL, recorded_at TEXT NOT NULL, version TEXT NOT NULL, note TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id), status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES staff(id)
);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, author TEXT NOT NULL REFERENCES staff(id), reviewer TEXT REFERENCES staff(id),
  event_id TEXT NOT NULL REFERENCES events(id), status TEXT NOT NULL, created_at TEXT NOT NULL,
  published_at TEXT, reason TEXT NOT NULL, evidence_ids TEXT NOT NULL, report_json TEXT NOT NULL
);
