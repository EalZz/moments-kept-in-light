-- 컬렉션을 행사와 개인 세션으로 구분하고, 개인 세션의 촬영 맥락을 저장합니다.
ALTER TABLE collections ADD COLUMN shoot_type TEXT NOT NULL DEFAULT 'event'
  CHECK (shoot_type IN ('event', 'session'));

ALTER TABLE collections ADD COLUMN location_type TEXT NOT NULL DEFAULT ''
  CHECK (location_type IN ('', 'venue', 'outdoor', 'studio'));

-- 개인 세션이 행사 중 별도 촬영에서 파생된 경우 원래 행사를 연결합니다.
-- 관계 삭제 시의 안전한 정리는 Worker에서 처리하므로 SQLite 외래키는 사용하지 않습니다.
ALTER TABLE collections ADD COLUMN related_event_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_collections_shoot_type
  ON collections (shoot_type, deleted_at, published, sort_order, date);
