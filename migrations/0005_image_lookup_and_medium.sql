-- 중간 사이즈(1280px) 변형. 기존 사진은 NULL이며 key_large로 폴백합니다.
ALTER TABLE photos ADD COLUMN key_medium TEXT;

-- /img/* 는 요청마다 키로 사진을 찾습니다. 인덱스가 없으면 이미지 1장당 photos 전체 스캔이 발생합니다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_key_large ON photos(key_large);
CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_key_thumb ON photos(key_thumb);
CREATE INDEX IF NOT EXISTS idx_photos_key_medium ON photos(key_medium);

-- 만료된 로그인 시도 정리(크론)용
CREATE INDEX IF NOT EXISTS idx_login_attempts_window ON login_attempts(window_started_at);

-- 휴지통 조회 및 보관기한 만료 정리(크론)용
CREATE INDEX IF NOT EXISTS idx_photos_deleted_at ON photos(deleted_at);
CREATE INDEX IF NOT EXISTS idx_collections_deleted_at ON collections(deleted_at);
