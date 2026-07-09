import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

const app = new Hono()

// ---------- DB init (prototype: create tables on first request) ----------
let initialized = false
async function initDb(db) {
  if (initialized) return
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      date TEXT DEFAULT '',
      cover_photo_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL,
      group_id INTEGER,
      key_large TEXT NOT NULL,
      key_thumb TEXT NOT NULL,
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      taken_at TEXT DEFAULT '',
      exif_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS model_aliases (
      old_handle TEXT PRIMARY KEY,
      new_handle TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS model_names (
      handle TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS site_daily_views (
      view_date TEXT PRIMARY KEY,
      views INTEGER NOT NULL DEFAULT 0
    )`),
  ])
  // 기존 DB 마이그레이션: photos.group_id 없으면 추가
  await db.prepare('ALTER TABLE photos ADD COLUMN group_id INTEGER').run().catch(() => {})
  // 확장용 메타(장소, 크레딧 등 나중에 자유롭게 추가) — JSON으로 저장해 스키마 변경 없이 확장
  await db.prepare(`ALTER TABLE collections ADD COLUMN meta_json TEXT DEFAULT '{}'`).run().catch(() => {})
  await db.prepare(`ALTER TABLE groups ADD COLUMN meta_json TEXT DEFAULT '{}'`).run().catch(() => {})
  // 수동 정렬 (NULL = 아직 정렬 안 함 → 촬영시간순 뒤에 배치)
  await db.prepare('ALTER TABLE photos ADD COLUMN sort_order INTEGER').run().catch(() => {})
  await db.prepare('ALTER TABLE groups ADD COLUMN sort_order INTEGER').run().catch(() => {})
  // 컬렉션 수동 정렬 (NULL = 새 컬렉션 → 맨 위)
  await db.prepare('ALTER TABLE collections ADD COLUMN sort_order INTEGER').run().catch(() => {})
  initialized = true
}
app.use('*', async (c, next) => {
  await initDb(c.env.DB)
  await next()
})

// ---------- auth ----------
async function sessionToken(env) {
  const data = new TextEncoder().encode('pht-pp-session-v1|' + env.ADMIN_PASSWORD)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function isAdmin(c) {
  const tok = getCookie(c, 'session')
  return !!tok && tok === (await sessionToken(c.env))
}
const requireAdmin = async (c, next) => {
  if (!(await isAdmin(c))) return c.json({ error: 'unauthorized' }, 401)
  await next()
}

app.post('/api/login', async (c) => {
  const { password } = await c.req.json()
  if (!password || password !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: 'wrong password' }, 401)
  }
  setCookie(c, 'session', await sessionToken(c.env), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.json({ ok: true })
})
app.post('/api/logout', (c) => {
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ ok: true })
})
app.get('/api/me', async (c) => c.json({ admin: await isAdmin(c) }))

// ---------- site views (KST 기준 일별 누적) ----------
// 브라우저의 실제 문서 이동만 집계합니다. 링크 미리보기 봇·API·이미지 요청은 제외합니다.
function isDirectPageVisit(c) {
  return c.req.header('sec-fetch-dest') === 'document' && c.req.header('sec-fetch-mode') === 'navigate'
}
async function recordSiteView(db) {
  await db.prepare(
    `INSERT INTO site_daily_views (view_date, views)
     VALUES (date('now', '+9 hours'), 1)
     ON CONFLICT(view_date) DO UPDATE SET views = views + 1`
  ).run()
}

app.get('/api/stats', requireAdmin, async (c) => {
  const requestedDays = Number(c.req.query('days') || 30)
  const days = Math.min(90, Math.max(7, Number.isFinite(requestedDays) ? Math.floor(requestedDays) : 30))
  const [totalResult, dailyResult] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COALESCE(SUM(views), 0) AS total_views FROM site_daily_views'),
    c.env.DB.prepare('SELECT view_date, views FROM site_daily_views ORDER BY view_date DESC LIMIT ?').bind(days),
  ])
  const viewsByDate = new Map((dailyResult.results || []).map((row) => [row.view_date, row.views]))
  const kstNow = Date.now() + 9 * 60 * 60 * 1000
  const daily = Array.from({ length: days }, (_, i) => {
    const view_date = new Date(kstNow - (days - 1 - i) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    return { view_date, views: viewsByDate.get(view_date) || 0 }
  })
  const today = daily.at(-1)
  return c.json({
    total_views: totalResult.results?.[0]?.total_views || 0,
    today_views: today?.views || 0,
    daily,
  })
})

// ---------- collections ----------
app.get('/api/collections', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT col.*, p.key_thumb AS cover_thumb, p.key_large AS cover_large,
            p.width AS cover_w, p.height AS cover_h, p.group_id AS cover_group,
            (SELECT COUNT(*) FROM photos WHERE collection_id = col.id) AS photo_count,
            (SELECT key_thumb FROM photos WHERE collection_id = col.id ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_thumb,
            (SELECT key_large FROM photos WHERE collection_id = col.id ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_large,
            (SELECT width FROM photos WHERE collection_id = col.id ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_w,
            (SELECT height FROM photos WHERE collection_id = col.id ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_h
     FROM collections col
     LEFT JOIN photos p ON p.id = col.cover_photo_id
     ORDER BY (col.sort_order IS NOT NULL), col.sort_order, col.date DESC, col.id ASC`
  ).all()
  // 카드 미리보기용 썸네일 (대표 제외 최대 3장)
  // 같은 사람(폴더) 사진만 연속으로 나오지 않게, 대표와 다른 폴더에서 한 장씩 우선 선택
  const { results: thumbRows } = await c.env.DB.prepare(
    'SELECT collection_id, group_id, key_thumb FROM photos ORDER BY (sort_order IS NULL), sort_order, taken_at, id'
  ).all()
  const thumbsByCol = {}
  for (const t of thumbRows) (thumbsByCol[t.collection_id] ||= []).push(t)
  // 폴더(사람) 순서 — 카드 썸네일이 이 순서를 따름
  const { results: groupRows } = await c.env.DB.prepare(
    'SELECT id, collection_id FROM groups ORDER BY (sort_order IS NULL), sort_order, id'
  ).all()
  const groupOrderByCol = {}
  for (const g of groupRows) (groupOrderByCol[g.collection_id] ||= []).push(g.id)
  for (const r of results) {
    r.cover_thumb = r.cover_thumb || r.first_thumb
    r.cover_large = r.cover_large || r.first_large
    r.cover_w = r.cover_w || r.first_w
    r.cover_h = r.cover_h || r.first_h
    const pool = (thumbsByCol[r.id] || []).filter((t) => t.key_thumb !== r.cover_thumb)
    // 사람(폴더)별로 묶고, 폴더 순서 → 폴더 없는 사진 → 대표 사진의 폴더(후순위) 순으로 한 장씩
    const byBucket = {}
    for (const t of pool) {
      const b = t.group_id || 0
      ;(byBucket[b] ||= []).push(t.key_thumb)
    }
    let buckets = [...(groupOrderByCol[r.id] || []), 0].filter((b) => byBucket[b])
    if (r.cover_group) buckets = buckets.filter((b) => b !== r.cover_group).concat(byBucket[r.cover_group] ? [r.cover_group] : [])
    const diverse = buckets.map((b) => byBucket[b][0])
    const rest = buckets.flatMap((b) => byBucket[b].slice(1))
    r.preview_thumbs = diverse.concat(rest).slice(0, 3)
    delete r.cover_group
    delete r.first_thumb
    delete r.first_large
    delete r.first_w
    delete r.first_h
  }
  return c.json(results)
})

app.post('/api/collections', requireAdmin, async (c) => {
  const { title, date = '', description = '' } = await c.req.json()
  if (!title) return c.json({ error: 'title required' }, 400)
  const { meta } = await c.env.DB.prepare(
    'INSERT INTO collections (title, date, description) VALUES (?, ?, ?)'
  ).bind(title, date, description).run()
  return c.json({ id: meta.last_row_id })
})

app.get('/api/collections/:id', async (c) => {
  const id = c.req.param('id')
  const col = await c.env.DB.prepare('SELECT * FROM collections WHERE id = ?').bind(id).first()
  if (!col) return c.json({ error: 'not found' }, 404)
  const { results: photos } = await c.env.DB.prepare(
    'SELECT * FROM photos WHERE collection_id = ? ORDER BY (sort_order IS NULL), sort_order, taken_at, id'
  ).bind(id).all()
  for (const p of photos) p.exif = JSON.parse(p.exif_json || '{}')
  const { results: groups } = await c.env.DB.prepare(
    'SELECT * FROM groups WHERE collection_id = ? ORDER BY (sort_order IS NULL), sort_order, id'
  ).bind(id).all()
  for (const g of groups) g.meta = JSON.parse(g.meta_json || '{}')
  return c.json({ ...col, photos, groups })
})

// ---------- 수동 정렬 저장 ----------
// 컬렉션 순서: 전체 컬렉션 id를 표시 순서대로 받아 저장
app.put('/api/collection-order', requireAdmin, async (c) => {
  const { ids } = await c.req.json()
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: 'ids required' }, 400)
  await c.env.DB.batch(ids.map((cid, i) =>
    c.env.DB.prepare('UPDATE collections SET sort_order = ? WHERE id = ?').bind(i, cid)))
  return c.json({ ok: true })
})

// 사진 순서: 컬렉션 내 전체 사진 id를 표시 순서대로 받아 저장
app.put('/api/collections/:id/photo-order', requireAdmin, async (c) => {
  const { ids } = await c.req.json()
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: 'ids required' }, 400)
  await c.env.DB.batch(ids.map((pid, i) =>
    c.env.DB.prepare('UPDATE photos SET sort_order = ? WHERE id = ? AND collection_id = ?')
      .bind(i, pid, c.req.param('id'))))
  return c.json({ ok: true })
})

// 폴더(사람) 순서
app.put('/api/collections/:id/group-order', requireAdmin, async (c) => {
  const { ids } = await c.req.json()
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: 'ids required' }, 400)
  await c.env.DB.batch(ids.map((gid, i) =>
    c.env.DB.prepare('UPDATE groups SET sort_order = ? WHERE id = ? AND collection_id = ?')
      .bind(i, gid, c.req.param('id'))))
  return c.json({ ok: true })
})

// ---------- 모델 아카이브 ----------
// 별칭 해석: 옛핸들 → 새핸들 (연쇄 5단계까지)
function resolveAlias(aliases, h) {
  let cur = h, hops = 0
  while (aliases[cur] && hops < 5) { cur = aliases[cur]; hops++ }
  return cur
}

// 공통 데이터: 폴더/컬렉션/별칭/이름 로드
async function loadModelBase(db) {
  const { results: groups } = await db.prepare('SELECT id, collection_id, name, meta_json FROM groups').all()
  const { results: cols } = await db.prepare(
    'SELECT id, title, date FROM collections ORDER BY (sort_order IS NOT NULL), sort_order, date DESC, id ASC'
  ).all()
  const { results: aliasRows } = await db.prepare('SELECT * FROM model_aliases').all()
  const { results: nameRows } = await db.prepare('SELECT * FROM model_names').all()
  const aliases = {}
  for (const a of aliasRows) aliases[a.old_handle.toLowerCase()] = a.new_handle
  const names = {}
  for (const n of nameRows) names[n.handle.toLowerCase()] = n.name
  for (const g of groups) {
    g.handles = [].concat(JSON.parse(g.meta_json || '{}').twitter || [])
    g.character = JSON.parse(g.meta_json || '{}').character || ''
  }
  return { groups, cols, aliases, names }
}

// 모델 목록: 핸들 기준 자동 집계 (별칭 병합)
app.get('/api/models', async (c) => {
  const { groups, cols, aliases, names } = await loadModelBase(c.env.DB)
  const colOrder = new Map(cols.map((col, i) => [col.id, i]))
  const { results: thumbRows } = await c.env.DB.prepare(
    'SELECT group_id, key_thumb FROM photos WHERE group_id IS NOT NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id'
  ).all()
  const firstThumb = {}, cnt = {}
  for (const t of thumbRows) {
    if (!(t.group_id in firstThumb)) firstThumb[t.group_id] = t.key_thumb
    cnt[t.group_id] = (cnt[t.group_id] || 0) + 1
  }
  const models = {} // canonical(lower) → data
  for (const g of groups) {
    if (!cnt[g.id]) continue
    for (const h of g.handles) {
      const canon = resolveAlias(aliases, h.toLowerCase())
      const m = (models[canon] ||= { handle: h, photo_count: 0, cols: new Set(), best: null, soloName: null })
      if (resolveAlias(aliases, h.toLowerCase()) === h.toLowerCase()) m.handle = h // 원 표기 유지
      m.photo_count += cnt[g.id]
      m.cols.add(g.collection_id)
      const ord = colOrder.get(g.collection_id) ?? 999
      if (!m.best || ord < m.best.ord) m.best = { ord, thumb: firstThumb[g.id] }
      if (g.handles.length === 1 && (!m.soloOrd || ord < m.soloOrd)) { m.soloName = g.name; m.soloOrd = ord }
    }
  }
  const out = Object.entries(models).map(([canon, m]) => ({
    handle: m.handle,
    name: names[canon] || m.soloName || '@' + m.handle,
    photo_count: m.photo_count,
    collection_count: m.cols.size,
    cover_thumb: m.best && m.best.thumb,
    _ord: m.best ? m.best.ord : 999,
  })).sort((a, b) => a._ord - b._ord)
  out.forEach((m) => delete m._ord)
  return c.json(out)
})

// 모델 상세: 행사별 섹션으로 사진 묶음
app.get('/api/models/:handle', async (c) => {
  const raw = c.req.param('handle')
  const { groups, cols, aliases, names } = await loadModelBase(c.env.DB)
  const canon = resolveAlias(aliases, raw.toLowerCase())
  const mine = groups.filter((g) => g.handles.some((h) => resolveAlias(aliases, h.toLowerCase()) === canon))
  if (!mine.length) return c.json({ error: 'not found' }, 404)
  const ids = mine.map((g) => g.id)
  const { results: photos } = await c.env.DB.prepare(
    `SELECT * FROM photos WHERE group_id IN (${ids.map(() => '?').join(',')})
     ORDER BY (sort_order IS NULL), sort_order, taken_at, id`
  ).bind(...ids).all()
  const byGroup = {}
  for (const p of photos) (byGroup[p.group_id] ||= []).push(p)
  // 섹션: 컬렉션 표시 순서(최신 우선)대로
  const sections = []
  for (const col of cols) {
    for (const g of mine.filter((x) => x.collection_id === col.id)) {
      if (!byGroup[g.id]) continue
      sections.push({
        collection_id: col.id,
        title: col.title,
        date: col.date,
        character: g.character,
        handles: g.handles,
        photos: byGroup[g.id],
      })
    }
  }
  // 표시 이름: 등록 이름 → 단독 폴더명 → @핸들
  const solo = mine.find((g) => g.handles.length === 1)
  const display = mine.find((g) => resolveAlias(aliases, (g.handles[0] || '').toLowerCase()) === canon)
  const handle = (display && display.handles.find((h) => resolveAlias(aliases, h.toLowerCase()) === canon)) || raw
  return c.json({
    handle,
    name: names[canon] || (solo && solo.name) || '@' + handle,
    photo_count: photos.length,
    sections,
  })
})

// ---------- 모델 별칭/이름 관리 (admin) ----------
app.get('/api/model-aliases', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM model_aliases ORDER BY old_handle').all()
  return c.json(results)
})

app.put('/api/model-aliases', requireAdmin, async (c) => {
  const { old_handle, new_handle } = await c.req.json()
  const o = String(old_handle || '').trim().replace(/^@/, '')
  const n = String(new_handle || '').trim().replace(/^@/, '')
  if (!o || !n || o.toLowerCase() === n.toLowerCase()) return c.json({ error: 'invalid handles' }, 400)
  await c.env.DB.prepare(
    `INSERT INTO model_aliases (old_handle, new_handle) VALUES (?, ?)
     ON CONFLICT(old_handle) DO UPDATE SET new_handle = excluded.new_handle`
  ).bind(o.toLowerCase(), n).run()
  return c.json({ ok: true })
})

app.delete('/api/model-aliases/:old', requireAdmin, async (c) => {
  await c.env.DB.prepare('DELETE FROM model_aliases WHERE old_handle = ?')
    .bind(c.req.param('old').toLowerCase()).run()
  return c.json({ ok: true })
})

// 표시 이름 — auto: 트윗 가져오기의 자동 저장(이미 있으면 유지), 수동: 덮어쓰기(빈값 = 삭제)
app.put('/api/model-names', requireAdmin, async (c) => {
  const { handle, name, auto = false } = await c.req.json()
  const h = String(handle || '').trim().replace(/^@/, '').toLowerCase()
  const nm = String(name || '').trim()
  if (!h) return c.json({ error: 'handle required' }, 400)
  if (!nm) {
    await c.env.DB.prepare('DELETE FROM model_names WHERE handle = ?').bind(h).run()
  } else if (auto) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO model_names (handle, name) VALUES (?, ?)').bind(h, nm).run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO model_names (handle, name) VALUES (?, ?)
       ON CONFLICT(handle) DO UPDATE SET name = excluded.name`
    ).bind(h, nm).run()
  }
  return c.json({ ok: true })
})

// 전체 사진 스트림 (Photos 페이지) — 컬렉션 표시 순서 → 사진 순서, 페이지네이션
app.get('/api/photos', async (c) => {
  const limit = Math.min(100, +(c.req.query('limit') || 60) || 60)
  const offset = Math.max(0, +(c.req.query('offset') || 0) || 0)
  const { results } = await c.env.DB.prepare(
    `SELECT p.key_thumb, p.key_large, p.width, p.height, p.collection_id,
            col.title, g.meta_json AS g_meta
     FROM photos p
     JOIN collections col ON col.id = p.collection_id
     LEFT JOIN groups g ON g.id = p.group_id
     ORDER BY (col.sort_order IS NOT NULL), col.sort_order, col.date DESC, col.id ASC,
              (p.sort_order IS NULL), p.sort_order, p.taken_at, p.id
     LIMIT ? OFFSET ?`
  ).bind(limit, offset).all()
  const totalRow = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM photos').first()
  return c.json({
    total: totalRow.n,
    photos: results.map((r) => {
      const meta = JSON.parse(r.g_meta || '{}')
      return {
        key_thumb: r.key_thumb,
        key_large: r.key_large,
        width: r.width,
        height: r.height,
        collection_id: r.collection_id,
        title: r.title,
        models: [].concat(meta.twitter || []),
        character: meta.character || '',
      }
    }),
  })
})

// 홈 랜덤 슬라이드용: 전체 사진 + 행사명 + 모델 크레딧
app.get('/api/feature-photos', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.key_large, p.collection_id, p.group_id, col.title, g.meta_json AS g_meta
     FROM photos p
     JOIN collections col ON col.id = p.collection_id
     LEFT JOIN groups g ON g.id = p.group_id`
  ).all()
  return c.json(results.map((r) => {
    const meta = JSON.parse(r.g_meta || '{}')
    return {
      key_large: r.key_large,
      collection_id: r.collection_id,
      group_id: r.group_id,
      title: r.title,
      models: [].concat(meta.twitter || []),
      character: meta.character || '',
    }
  }))
})

// ---------- site settings (메인에 걸 컬렉션 등) ----------
app.get('/api/settings', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT key, value FROM settings').all()
  const map = Object.fromEntries(results.map((r) => [r.key, r.value]))
  let about = null
  try { about = map.about ? JSON.parse(map.about) : null } catch {}
  return c.json({
    featured_collection_id: map.featured_collection_id ? +map.featured_collection_id : null,
    about,
  })
})

app.patch('/api/settings', requireAdmin, async (c) => {
  const body = await c.req.json()
  const put = (k, v) => c.env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(k, v).run()
  if ('featured_collection_id' in body) {
    await put('featured_collection_id', body.featured_collection_id == null ? '' : String(body.featured_collection_id))
  }
  if ('about' in body) {
    await put('about', JSON.stringify(body.about || {}))
  }
  return c.json({ ok: true })
})

// ---------- groups (컬렉션 안의 사람별 폴더) ----------
app.post('/api/collections/:id/groups', requireAdmin, async (c) => {
  const collectionId = c.req.param('id')
  const { name } = await c.req.json()
  if (!name) return c.json({ error: 'name required' }, 400)
  const { meta } = await c.env.DB.prepare(
    'INSERT INTO groups (collection_id, name) VALUES (?, ?)'
  ).bind(collectionId, name).run()
  return c.json({ id: meta.last_row_id })
})

app.patch('/api/groups/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const g = await c.env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(id).first()
  if (!g) return c.json({ error: 'not found' }, 404)
  const body = await c.req.json()
  const name = 'name' in body ? body.name : g.name
  if (!name) return c.json({ error: 'name required' }, 400)
  const meta = JSON.parse(g.meta_json || '{}')
  // 모델(코스어) X 핸들 — 쉼표/공백 구분으로 여러 명 가능, 빈 문자열이면 삭제
  if ('twitter' in body) {
    const handles = String(body.twitter || '')
      .split(/[,\s]+/)
      .map((h) => h.trim().replace(/^@/, ''))
      .filter(Boolean)
    if (handles.length) meta.twitter = handles
    else delete meta.twitter
  }
  // 캐릭터명 — 빈 문자열이면 삭제
  if ('character' in body) {
    const character = String(body.character || '').trim()
    if (character) meta.character = character
    else delete meta.character
  }
  await c.env.DB.prepare('UPDATE groups SET name = ?, meta_json = ? WHERE id = ?')
    .bind(name, JSON.stringify(meta), id).run()
  return c.json({ ok: true })
})

// 폴더 삭제: 사진은 지우지 않고 컬렉션 바로 아래로 이동
app.delete('/api/groups/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE photos SET group_id = NULL WHERE group_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(id),
  ])
  return c.json({ ok: true })
})

app.patch('/api/collections/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields = ['title', 'date', 'description', 'cover_photo_id']
  const sets = [], vals = []
  for (const f of fields) {
    if (f in body) { sets.push(`${f} = ?`); vals.push(body[f]) }
  }
  if (!sets.length) return c.json({ error: 'no fields' }, 400)
  await c.env.DB.prepare(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...vals, id).run()
  return c.json({ ok: true })
})

app.delete('/api/collections/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const { results: photos } = await c.env.DB.prepare(
    'SELECT key_large, key_thumb FROM photos WHERE collection_id = ?'
  ).bind(id).all()
  const keys = photos.flatMap((p) => [p.key_large, p.key_thumb])
  if (keys.length) await c.env.PHOTOS.delete(keys)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM photos WHERE collection_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(id),
  ])
  return c.json({ ok: true })
})

// ---------- photos ----------
app.post('/api/collections/:id/photos', requireAdmin, async (c) => {
  const collectionId = c.req.param('id')
  const col = await c.env.DB.prepare('SELECT id, cover_photo_id FROM collections WHERE id = ?')
    .bind(collectionId).first()
  if (!col) return c.json({ error: 'collection not found' }, 404)

  const form = await c.req.formData()
  const large = form.get('large')
  const thumb = form.get('thumb')
  if (!large || !thumb) return c.json({ error: 'large and thumb files required' }, 400)

  const width = parseInt(form.get('width') || '0', 10)
  const height = parseInt(form.get('height') || '0', 10)
  const takenAt = form.get('taken_at') || ''
  const exifJson = form.get('exif') || '{}'
  let groupId = parseInt(form.get('group_id') || '0', 10) || null
  if (groupId) {
    const g = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ? AND collection_id = ?')
      .bind(groupId, collectionId).first()
    if (!g) groupId = null
  }

  const uuid = crypto.randomUUID()
  const ext = (large.type === 'image/jpeg') ? 'jpg' : 'webp'
  const keyLarge = `p/${collectionId}/${uuid}-l.${ext}`
  const keyThumb = `p/${collectionId}/${uuid}-t.${ext}`
  await c.env.PHOTOS.put(keyLarge, large.stream(), { httpMetadata: { contentType: large.type } })
  await c.env.PHOTOS.put(keyThumb, thumb.stream(), { httpMetadata: { contentType: thumb.type } })

  const { meta } = await c.env.DB.prepare(
    `INSERT INTO photos (collection_id, group_id, key_large, key_thumb, width, height, taken_at, exif_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(collectionId, groupId, keyLarge, keyThumb, width, height, takenAt, exifJson).run()

  // 첫 사진이면 자동으로 대표 지정
  if (!col.cover_photo_id) {
    await c.env.DB.prepare('UPDATE collections SET cover_photo_id = ? WHERE id = ?')
      .bind(meta.last_row_id, collectionId).run()
  }
  return c.json({ id: meta.last_row_id, key_large: keyLarge, key_thumb: keyThumb })
})

// 사진을 다른 폴더로 이동 (group_id: null = 컬렉션 바로 아래)
app.patch('/api/photos/:id', requireAdmin, async (c) => {
  const { group_id = null } = await c.req.json()
  await c.env.DB.prepare('UPDATE photos SET group_id = ? WHERE id = ?')
    .bind(group_id, c.req.param('id')).run()
  return c.json({ ok: true })
})

app.delete('/api/photos/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const photo = await c.env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first()
  if (!photo) return c.json({ error: 'not found' }, 404)
  await c.env.PHOTOS.delete([photo.key_large, photo.key_thumb])
  await c.env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run()
  // 대표 사진이었으면 다른 사진으로 교체
  const col = await c.env.DB.prepare('SELECT cover_photo_id FROM collections WHERE id = ?')
    .bind(photo.collection_id).first()
  if (col && col.cover_photo_id === photo.id) {
    const next = await c.env.DB.prepare(
      'SELECT id FROM photos WHERE collection_id = ? ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1'
    ).bind(photo.collection_id).first()
    await c.env.DB.prepare('UPDATE collections SET cover_photo_id = ? WHERE id = ?')
      .bind(next ? next.id : null, photo.collection_id).run()
  }
  return c.json({ ok: true })
})

// ---------- tweet import ----------
// 트윗 URL → 사진 URL 목록 (fxtwitter 공개 API 사용)
app.get('/api/tweet-media', requireAdmin, async (c) => {
  const url = c.req.query('url') || ''
  const m = url.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/)
  if (!m) return c.json({ error: '트윗 URL 형식이 아닙니다' }, 400)
  const res = await fetch(`https://api.fxtwitter.com/status/${m[1]}`, {
    headers: { 'User-Agent': 'pht-pp/1.0' },
  })
  if (!res.ok) return c.json({ error: '트윗 정보를 가져오지 못했습니다 (' + res.status + ')' }, 502)
  const data = await res.json()
  const photos = (data.tweet?.media?.photos || []).map((p) => ({
    // name=orig 로 트위터가 보관 중인 최대 해상도 요청
    url: p.url.includes('name=') ? p.url : p.url + (p.url.includes('?') ? '&' : '?') + 'name=orig',
    width: p.width,
    height: p.height,
  }))
  if (!photos.length) return c.json({ error: '이 트윗에는 사진이 없습니다' }, 404)
  return c.json({ photos, text: data.tweet?.text || '' })
})

// 브라우저 CORS 우회용 이미지 프록시 (트위터 CDN만 허용)
app.get('/api/fetch-image', requireAdmin, async (c) => {
  const url = c.req.query('url') || ''
  let host
  try { host = new URL(url).hostname } catch { return c.text('bad url', 400) }
  if (host !== 'pbs.twimg.com') return c.text('host not allowed', 403)
  const res = await fetch(url, { headers: { 'User-Agent': 'pht-pp/1.0' } })
  if (!res.ok) return c.text('fetch failed', 502)
  return new Response(res.body, {
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'image/jpeg' },
  })
})

// ---------- OG 태그 (트위터/카톡 공유 미리보기 카드) ----------
// 문구는 public/config.js와 맞춰서 관리
const OG_TITLE = 'Moments Kept in Light'
const OG_DESC = 'The moments we met, frame by frame.'

app.get('/', async (c) => {
  // 로그인한 관리자의 갤러리 확인은 조회수에서 제외합니다.
  // 통계 저장 실패가 갤러리 자체를 막지는 않도록 분리합니다.
  if (isDirectPageVisit(c) && !(await isAdmin(c))) {
    await recordSiteView(c.env.DB).catch((error) => console.error('site view recording failed', error))
  }
  const res = await c.env.ASSETS.fetch(c.req.raw)
  let html = await res.text()

  // 링크 미리보기 카드: 브랜드 로고 카드(og.png) — 모델 사진 대신
  const origin = new URL(c.req.url).origin
  const ogImage = origin + '/og.png'
  const tags = [
    `<meta name="description" content="${OG_DESC}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${OG_TITLE}" />`,
    `<meta property="og:description" content="${OG_DESC}" />`,
    `<meta property="og:url" content="${origin}/" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${OG_TITLE}" />`,
    `<meta name="twitter:description" content="${OG_DESC}" />`,
    `<meta name="twitter:image" content="${ogImage}" />`,
  ].join('\n  ')
  html = html.replace('</head>', '  ' + tags + '\n</head>')
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

// ---------- image serving (R2) ----------
app.get('/img/*', async (c) => {
  const key = c.req.path.slice('/img/'.length)
  const obj = await c.env.PHOTOS.get(key)
  if (!obj) return c.text('not found', 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: obj.httpEtag,
    },
  })
})

export default app
