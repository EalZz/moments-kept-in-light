-- 작품(장르)은 groups.meta_json 안의 값이라 테이블이 없었습니다.
-- 작품 단위로 붙일 정보(대표 사진 등)를 담습니다. 행이 없으면 첫 사진을 대표로 씁니다.
CREATE TABLE IF NOT EXISTS series_meta (
  name TEXT PRIMARY KEY,
  cover_photo_id INTEGER
);

-- 검색 별칭. 행사·작품·모델의 공식명이 영어여도 통칭으로 찾히게 합니다.
-- 예: kind='collection', target='6', alias='서코' / kind='series', target='승리의 여신: 니케', alias='니케'
CREATE TABLE IF NOT EXISTS search_aliases (
  kind TEXT NOT NULL,      -- collection | series | model
  target TEXT NOT NULL,    -- 컬렉션 id · 작품명 · 모델 핸들
  alias TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (kind, target, alias)
);
CREATE INDEX IF NOT EXISTS idx_search_aliases_kind ON search_aliases(kind, target);
