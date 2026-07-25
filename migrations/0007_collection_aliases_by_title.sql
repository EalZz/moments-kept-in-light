-- 같은 이름의 행사가 날짜만 다르게 여러 개 있습니다(예: Comic World 3개).
-- 별칭을 컬렉션 id에 걸면 그 회차만 검색되므로, 행사 '이름' 기준으로 바꿉니다.
-- 이렇게 하면 검색어를 한 번만 등록해도 같은 이름의 모든 회차가 함께 찾힙니다.

-- 기존 id 기반 별칭을 같은 이름의 별칭으로 옮깁니다.
INSERT OR IGNORE INTO search_aliases (kind, target, alias)
SELECT 'collection', c.title, sa.alias
FROM search_aliases sa
JOIN collections c ON c.id = CAST(sa.target AS INTEGER)
WHERE sa.kind = 'collection';

-- 옮긴 뒤 id를 가리키던 행만 지웁니다(이름을 가리키는 행은 남깁니다).
DELETE FROM search_aliases
WHERE kind = 'collection'
  AND target IN (SELECT CAST(id AS TEXT) FROM collections);
