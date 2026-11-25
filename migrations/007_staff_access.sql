ALTER TABLE staff ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1));
ALTER TABLE staff ADD COLUMN access_managed INTEGER NOT NULL DEFAULT 0 CHECK(access_managed IN (0,1));
UPDATE staff SET org_id=NULL WHERE role='admin';
UPDATE staff SET label='系統管理員' WHERE id='admin' AND label='系統管理';
CREATE TRIGGER staff_access_insert BEFORE INSERT ON staff
WHEN NEW.role NOT IN ('operator','identity','analyst','publisher','admin') OR (NEW.role='admin' AND NEW.org_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'STAFF_ACCESS_INVALID'); END;
CREATE TRIGGER staff_access_update BEFORE UPDATE OF role,org_id ON staff
WHEN NEW.role NOT IN ('operator','identity','analyst','publisher','admin') OR (NEW.role='admin' AND NEW.org_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'STAFF_ACCESS_INVALID'); END;
