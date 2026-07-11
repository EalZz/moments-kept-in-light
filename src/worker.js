import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

const app = new Hono()

// ---------- DB schema ----------
// 신규 설치는 migrations/0001_initial.sql을 사용합니다. 아래 부트스트랩은 기존 배포 DB를
// 무중단으로 새 스키마에 올리기 위한 호환 계층이며, 누락 컬럼만 확인해서 추가합니다.
let initialized = false
let initializationPromise = null
async function ensureColumn(db, table, column, definition) {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all()
  if (!results.some((row) => row.name === column)) {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run()
  }
}
async function initializeDb(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      date TEXT DEFAULT '',
      cover_photo_id INTEGER,
      meta_json TEXT DEFAULT '{}',
      sort_order INTEGER,
      published INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      purge_started_at TEXT,
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
      sort_order INTEGER,
      deleted_at TEXT,
      purge_started_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      meta_json TEXT DEFAULT '{}',
      sort_order INTEGER,
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
    db.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
      client_key TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      window_started_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
  ])
  await ensureColumn(db, 'photos', 'group_id', 'INTEGER')
  await ensureColumn(db, 'collections', 'meta_json', "TEXT DEFAULT '{}'")
  await ensureColumn(db, 'groups', 'meta_json', "TEXT DEFAULT '{}'")
  await ensureColumn(db, 'photos', 'sort_order', 'INTEGER')
  await ensureColumn(db, 'groups', 'sort_order', 'INTEGER')
  await ensureColumn(db, 'collections', 'sort_order', 'INTEGER')
  await ensureColumn(db, 'collections', 'published', 'INTEGER NOT NULL DEFAULT 1')
  await ensureColumn(db, 'collections', 'deleted_at', 'TEXT')
  await ensureColumn(db, 'photos', 'deleted_at', 'TEXT')
  await ensureColumn(db, 'collections', 'purge_started_at', 'TEXT')
  await ensureColumn(db, 'photos', 'purge_started_at', 'TEXT')
  await db.batch([
    db.prepare('CREATE INDEX IF NOT EXISTS idx_collections_visibility ON collections(deleted_at, published, sort_order, date)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_photos_collection_order ON photos(collection_id, deleted_at, sort_order, taken_at, id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_photos_group ON photos(group_id, deleted_at, sort_order, id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_groups_collection_order ON groups(collection_id, sort_order, id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at)'),
  ])
  initialized = true
}
async function initDb(db) {
  if (initialized) return
  if (!initializationPromise) {
    initializationPromise = initializeDb(db).catch((error) => {
      initializationPromise = null
      throw error
    })
  }
  await initializationPromise
}
app.use('*', async (c, next) => {
  await initDb(c.env.DB)
  await next()
})

// ---------- auth ----------
const textEncoder = new TextEncoder()
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_LOGIN_FAILURES = 5

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function digest(value) {
  return crypto.subtle.digest('SHA-256', textEncoder.encode(String(value)))
}
async function safeEqual(a, b) {
  const [aHash, bHash] = await Promise.all([digest(a), digest(b)])
  return crypto.subtle.timingSafeEqual(aHash, bHash)
}
function toBase64Url(value) {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function signSession(payload, password) {
  const key = await crypto.subtle.importKey(
    'raw', textEncoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(payload))
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function createSessionToken(env) {
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000
  const sessionId = crypto.randomUUID()
  const payload = `${expiresAt}.${sessionId}`
  await env.DB.prepare('INSERT INTO admin_sessions (id, expires_at) VALUES (?, ?)')
    .bind(sessionId, expiresAt).run()
  return `${toBase64Url(payload)}.${await signSession(payload, env.ADMIN_PASSWORD)}`
}
async function verifySessionToken(token, env) {
  if (!token || !env.ADMIN_PASSWORD) return false
  const split = token.lastIndexOf('.')
  if (split <= 0) return false
  let payload
  try {
    const encoded = token.slice(0, split).replace(/-/g, '+').replace(/_/g, '/')
    payload = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))
  } catch {
    return false
  }
  const [expiresRaw, sessionId] = payload.split('.')
  const expiresAt = Number(expiresRaw)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !sessionId) return false
  if (!(await safeEqual(token.slice(split + 1), await signSession(payload, env.ADMIN_PASSWORD)))) return false
  return Boolean(await env.DB.prepare('SELECT id FROM admin_sessions WHERE id = ? AND expires_at = ?')
    .bind(sessionId, expiresAt).first())
}
async function isAdmin(c) {
  const tok = getCookie(c, 'session')
  return verifySessionToken(tok, c.env)
}
const requireAdmin = async (c, next) => {
  if (!(await isAdmin(c))) return c.json({ error: 'unauthorized' }, 401)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin')
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'forbidden origin' }, 403)
  }
  await next()
}

async function loginClientKey(c) {
  const raw = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
  const hash = await digest(raw)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function loginAllowed(db, clientKey) {
  const row = await db.prepare('SELECT attempts, window_started_at FROM login_attempts WHERE client_key = ?')
    .bind(clientKey).first()
  if (!row) return true
  if (Date.now() - row.window_started_at >= LOGIN_WINDOW_MS) {
    await db.prepare('DELETE FROM login_attempts WHERE client_key = ?').bind(clientKey).run()
    return true
  }
  return row.attempts < MAX_LOGIN_FAILURES
}
async function recordLoginFailure(db, clientKey) {
  const now = Date.now()
  await db.prepare(
    `INSERT INTO login_attempts (client_key, attempts, window_started_at) VALUES (?, 1, ?)
     ON CONFLICT(client_key) DO UPDATE SET
       attempts = CASE WHEN ? - window_started_at >= ? THEN 1 ELSE attempts + 1 END,
       window_started_at = CASE WHEN ? - window_started_at >= ? THEN ? ELSE window_started_at END`
  ).bind(clientKey, now, now, LOGIN_WINDOW_MS, now, LOGIN_WINDOW_MS, now).run()
}

app.post('/api/login', async (c) => {
  if (!c.env.ADMIN_PASSWORD) return c.json({ error: 'admin password is not configured' }, 503)
  const clientKey = await loginClientKey(c)
  if (!(await loginAllowed(c.env.DB, clientKey))) {
    return c.json({ error: 'too many attempts; try again later' }, 429)
  }
  const { password } = await c.req.json()
  if (!password || !(await safeEqual(password, c.env.ADMIN_PASSWORD))) {
    await recordLoginFailure(c.env.DB, clientKey)
    return c.json({ error: 'wrong password' }, 401)
  }
  await c.env.DB.prepare('DELETE FROM login_attempts WHERE client_key = ?').bind(clientKey).run()
  await c.env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(Date.now()).run()
  setCookie(c, 'session', await createSessionToken(c.env), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.json({ ok: true })
})
app.post('/api/logout', async (c) => {
  const token = getCookie(c, 'session')
  if (token) {
    try {
      const encoded = token.slice(0, token.lastIndexOf('.')).replace(/-/g, '+').replace(/_/g, '/')
      const payload = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))
      const sessionId = payload.split('.')[1]
      if (sessionId) await c.env.DB.prepare('DELETE FROM admin_sessions WHERE id = ?').bind(sessionId).run()
    } catch {}
  }
  deleteCookie(c, 'session', {
    path: '/',
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict',
  })
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
  const includeDrafts = await isAdmin(c)
  const visibility = includeDrafts ? 'col.deleted_at IS NULL' : 'col.deleted_at IS NULL AND col.published = 1'
  const { results } = await c.env.DB.prepare(
    `SELECT col.*, p.key_thumb AS cover_thumb, p.key_large AS cover_large,
            p.width AS cover_w, p.height AS cover_h, p.group_id AS cover_group,
            (SELECT COUNT(*) FROM photos WHERE collection_id = col.id AND deleted_at IS NULL) AS photo_count,
            (SELECT key_thumb FROM photos WHERE collection_id = col.id AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_thumb,
            (SELECT key_large FROM photos WHERE collection_id = col.id AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_large,
            (SELECT width FROM photos WHERE collection_id = col.id AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_w,
            (SELECT height FROM photos WHERE collection_id = col.id AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_h
     FROM collections col
     LEFT JOIN photos p ON p.id = col.cover_photo_id AND p.deleted_at IS NULL
     WHERE ${visibility}
     ORDER BY (col.sort_order IS NOT NULL), col.sort_order, col.date DESC, col.id ASC`
  ).all()
  // 카드 미리보기용 썸네일 (대표 제외 최대 3장)
  // 같은 사람(폴더) 사진만 연속으로 나오지 않게, 대표와 다른 폴더에서 한 장씩 우선 선택
  const { results: thumbRows } = await c.env.DB.prepare(
    'SELECT collection_id, group_id, key_thumb FROM photos WHERE deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id'
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
    'INSERT INTO collections (title, date, description, published) VALUES (?, ?, ?, 0)'
  ).bind(title, date, description).run()
  return c.json({ id: meta.last_row_id })
})

app.get('/api/collections/:id', async (c) => {
  const id = c.req.param('id')
  const includeDrafts = await isAdmin(c)
  const col = await c.env.DB.prepare(
    `SELECT * FROM collections WHERE id = ? AND deleted_at IS NULL${includeDrafts ? '' : ' AND published = 1'}`
  ).bind(id).first()
  if (!col) return c.json({ error: 'not found' }, 404)
  const { results: photos } = await c.env.DB.prepare(
    'SELECT * FROM photos WHERE collection_id = ? AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id'
  ).bind(id).all()
  for (const p of photos) p.exif = parseJsonObject(p.exif_json)
  const { results: groups } = await c.env.DB.prepare(
    'SELECT * FROM groups WHERE collection_id = ? ORDER BY (sort_order IS NULL), sort_order, id'
  ).bind(id).all()
  for (const g of groups) g.meta = parseJsonObject(g.meta_json)
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
async function loadModelBase(db, includeDrafts = false) {
  const { results: groups } = await db.prepare(
    `SELECT g.id, g.collection_id, g.name, g.meta_json
     FROM groups g JOIN collections c ON c.id = g.collection_id
     WHERE c.deleted_at IS NULL${includeDrafts ? '' : ' AND c.published = 1'}`
  ).all()
  const { results: cols } = await db.prepare(
    `SELECT id, title, date FROM collections
     WHERE deleted_at IS NULL${includeDrafts ? '' : ' AND published = 1'}
     ORDER BY (sort_order IS NOT NULL), sort_order, date DESC, id ASC`
  ).all()
  const { results: aliasRows } = await db.prepare('SELECT * FROM model_aliases').all()
  const { results: nameRows } = await db.prepare('SELECT * FROM model_names').all()
  const aliases = {}
  for (const a of aliasRows) aliases[a.old_handle.toLowerCase()] = a.new_handle
  const names = {}
  for (const n of nameRows) names[n.handle.toLowerCase()] = n.name
  for (const g of groups) {
    const metadata = parseJsonObject(g.meta_json)
    g.handles = [].concat(metadata.twitter || [])
    g.character = metadata.character || ''
  }
  return { groups, cols, aliases, names }
}

// 모델 목록: 핸들 기준 자동 집계 (별칭 병합)
app.get('/api/models', async (c) => {
  const includeDrafts = await isAdmin(c)
  const { groups, cols, aliases, names } = await loadModelBase(c.env.DB, includeDrafts)
  const colOrder = new Map(cols.map((col, i) => [col.id, i]))
  const { results: thumbRows } = await c.env.DB.prepare(
    'SELECT group_id, key_thumb FROM photos WHERE group_id IS NOT NULL AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id'
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
  const includeDrafts = await isAdmin(c)
  const { groups, cols, aliases, names } = await loadModelBase(c.env.DB, includeDrafts)
  const canon = resolveAlias(aliases, raw.toLowerCase())
  const mine = groups.filter((g) => g.handles.some((h) => resolveAlias(aliases, h.toLowerCase()) === canon))
  if (!mine.length) return c.json({ error: 'not found' }, 404)
  const ids = mine.map((g) => g.id)
  const { results: photos } = await c.env.DB.prepare(
    `SELECT * FROM photos WHERE deleted_at IS NULL AND group_id IN (${ids.map(() => '?').join(',')})
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
  const includeDrafts = await isAdmin(c)
  const limit = Math.min(100, +(c.req.query('limit') || 60) || 60)
  const offset = Math.max(0, +(c.req.query('offset') || 0) || 0)
  const { results } = await c.env.DB.prepare(
    `SELECT p.key_thumb, p.key_large, p.width, p.height, p.collection_id,
            col.title, g.meta_json AS g_meta
     FROM photos p
     JOIN collections col ON col.id = p.collection_id
     LEFT JOIN groups g ON g.id = p.group_id
     WHERE p.deleted_at IS NULL AND col.deleted_at IS NULL${includeDrafts ? '' : ' AND col.published = 1'}
     ORDER BY (col.sort_order IS NOT NULL), col.sort_order, col.date DESC, col.id ASC,
              (p.sort_order IS NULL), p.sort_order, p.taken_at, p.id
     LIMIT ? OFFSET ?`
  ).bind(limit, offset).all()
  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM photos p JOIN collections col ON col.id = p.collection_id
     WHERE p.deleted_at IS NULL AND col.deleted_at IS NULL${includeDrafts ? '' : ' AND col.published = 1'}`
  ).first()
  return c.json({
    total: totalRow.n,
    photos: results.map((r) => {
      const meta = parseJsonObject(r.g_meta)
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
  const includeDrafts = await isAdmin(c)
  const { results } = await c.env.DB.prepare(
    `SELECT p.key_large, p.collection_id, p.group_id, col.title, g.meta_json AS g_meta
     FROM photos p
     JOIN collections col ON col.id = p.collection_id
     LEFT JOIN groups g ON g.id = p.group_id
     WHERE p.deleted_at IS NULL AND col.deleted_at IS NULL${includeDrafts ? '' : ' AND col.published = 1'}`
  ).all()
  return c.json(results.map((r) => {
    const meta = parseJsonObject(r.g_meta)
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

// ---------- backup + trash ----------
app.get('/api/backup', requireAdmin, async (c) => {
  const tables = ['collections', 'groups', 'photos', 'settings', 'model_aliases', 'model_names', 'site_daily_views']
  const data = {}
  for (const table of tables) {
    const { results } = await c.env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    data[table] = results
  }
  const generatedAt = new Date().toISOString()
  return new Response(JSON.stringify({
    schema_version: 1,
    generated_at: generatedAt,
    note: 'R2 image binaries are not embedded. Photo rows contain the R2 object keys required for recovery.',
    data,
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="moments-backup-${generatedAt.slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
    },
  })
})

const BACKUP_PREFIX = '_backups/'
const BACKUP_BATCH_SIZE = 20
const BACKUP_RETENTION = 3
async function listAllObjects(bucket, prefix = '') {
  const objects = []
  let cursor
  do {
    const page = await bucket.list({ prefix, cursor })
    objects.push(...page.objects)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return objects
}

function validBackupId(id) {
  return /^[0-9TZ-]+$/.test(id || '')
}

async function readBackupManifest(bucket, id) {
  if (!validBackupId(id)) return null
  const stored = await bucket.get(`${BACKUP_PREFIX}${id}/manifest.json`)
  return stored ? JSON.parse(await stored.text()) : null
}

async function writeBackupManifest(bucket, manifest) {
  await bucket.put(`${BACKUP_PREFIX}${manifest.id}/manifest.json`, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  })
}

async function deleteBackup(bucket, id) {
  const objects = await listAllObjects(bucket, `${BACKUP_PREFIX}${id}/`)
  await deleteR2Keys(bucket, objects.map((object) => object.key))
}

async function rotateBackups(bucket) {
  const manifests = (await listAllObjects(bucket, BACKUP_PREFIX))
    .filter((object) => object.key.endsWith('/manifest.json'))
    .sort((a, b) => b.key.localeCompare(a.key))
  for (const object of manifests.slice(BACKUP_RETENTION)) {
    const id = object.key.split('/')[1]
    if (validBackupId(id)) await deleteBackup(bucket, id)
  }
}

// 먼저 DB가 참조하는 원본 키 목록을 고정하고, 실제 복사는 별도 배치 요청으로 진행합니다.
app.post('/api/backups', requireAdmin, async (c) => {
  const id = new Date().toISOString().replace(/[:.]/g, '-')
  const { results } = await c.env.DB.prepare('SELECT key_large, key_thumb FROM photos ORDER BY id').all()
  const keys = [...new Set(results.flatMap((photo) => [photo.key_large, photo.key_thumb]).filter(Boolean))]
  const manifest = { id, created_at: new Date().toISOString(), status: 'pending', completed: 0, objects: keys.map((key) => ({ key })) }
  await writeBackupManifest(c.env.PHOTOS, manifest)
  return c.json({ id, object_count: keys.length, completed: 0, done: keys.length === 0 })
})

app.post('/api/backups/:id/run', requireAdmin, async (c) => {
  const manifest = await readBackupManifest(c.env.PHOTOS, c.req.param('id'))
  if (!manifest) return c.json({ error: 'backup not found' }, 404)
  if (manifest.status === 'complete') return c.json({ id: manifest.id, object_count: manifest.objects.length, completed: manifest.completed, done: true })
  manifest.status = 'running'
  const end = Math.min(manifest.completed + BACKUP_BATCH_SIZE, manifest.objects.length)
  for (let index = manifest.completed; index < end; index++) {
    const entry = manifest.objects[index]
    const source = await c.env.PHOTOS.get(entry.key)
    if (!source) {
      entry.missing = true
      manifest.completed = index + 1
      continue
    }
    entry.backup_key = `${BACKUP_PREFIX}${manifest.id}/objects/${entry.key}`
    entry.size = source.size
    entry.etag = source.etag
    await c.env.PHOTOS.put(entry.backup_key, source.body, { httpMetadata: source.httpMetadata, customMetadata: source.customMetadata })
    manifest.completed = index + 1
  }
  const done = manifest.completed >= manifest.objects.length
  if (done) {
    manifest.status = 'complete'
    manifest.completed_at = new Date().toISOString()
  }
  await writeBackupManifest(c.env.PHOTOS, manifest)
  if (done) await rotateBackups(c.env.PHOTOS)
  return c.json({ id: manifest.id, object_count: manifest.objects.length, completed: manifest.completed, done })
})

app.get('/api/backups', requireAdmin, async (c) => {
  const manifests = (await listAllObjects(c.env.PHOTOS, BACKUP_PREFIX))
    .filter((object) => object.key.endsWith('/manifest.json'))
    .sort((a, b) => b.key.localeCompare(a.key))
  const backups = []
  for (const object of manifests) {
    const stored = await c.env.PHOTOS.get(object.key)
    if (stored) backups.push(JSON.parse(await stored.text()))
  }
  return c.json(backups.map(({ id, created_at, status, completed = 0, objects }) => ({
    id, created_at, status, completed, object_count: objects.length,
  })))
})

app.post('/api/backups/:id/restore', requireAdmin, async (c) => {
  const manifest = await readBackupManifest(c.env.PHOTOS, c.req.param('id'))
  if (!manifest) return c.json({ error: 'backup not found' }, 404)
  if (manifest.status !== 'complete') return c.json({ error: 'backup is not complete' }, 409)
  const body = await c.req.json().catch(() => ({}))
  const offset = Math.max(0, Number.parseInt(body.offset || '0', 10) || 0)
  const entries = (manifest.objects || []).slice(offset, offset + BACKUP_BATCH_SIZE)
  let restored = 0
  for (const entry of entries) {
    if (!entry.backup_key) continue
    const source = await c.env.PHOTOS.get(entry.backup_key)
    if (!source) return c.json({ error: `backup object missing: ${entry.key}` }, 409)
    await c.env.PHOTOS.put(entry.key, source.body, { httpMetadata: source.httpMetadata, customMetadata: source.customMetadata })
    restored++
  }
  const nextOffset = offset + entries.length
  return c.json({ restored, next_offset: nextOffset, done: nextOffset >= manifest.objects.length })
})

app.delete('/api/backups/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  if (!validBackupId(id)) return c.json({ error: 'invalid backup id' }, 400)
  if (!(await c.env.PHOTOS.head(`${BACKUP_PREFIX}${id}/manifest.json`))) return c.json({ error: 'backup not found' }, 404)
  await deleteBackup(c.env.PHOTOS, id)
  return c.json({ ok: true })
})

async function removeKeysFromBackups(bucket, keys) {
  const targets = new Set(keys)
  if (!targets.size) return 0
  const manifests = (await listAllObjects(bucket, BACKUP_PREFIX)).filter((object) => object.key.endsWith('/manifest.json'))
  let removed = 0
  for (const object of manifests) {
    const stored = await bucket.get(object.key)
    if (!stored) continue
    const manifest = JSON.parse(await stored.text())
    const matched = manifest.objects.filter((entry) => targets.has(entry.key))
    await deleteR2Keys(bucket, matched.map((entry) => entry.backup_key).filter(Boolean))
    manifest.objects = manifest.objects.filter((entry) => !targets.has(entry.key))
    manifest.completed = Math.min(manifest.completed || 0, manifest.objects.length)
    await writeBackupManifest(bucket, manifest)
    removed += matched.length
  }
  return removed
}

app.get('/api/trash', requireAdmin, async (c) => {
  const [{ results: collections }, { results: photos }] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT c.*, COUNT(p.id) AS photo_count
       FROM collections c LEFT JOIN photos p ON p.collection_id = c.id
       WHERE c.deleted_at IS NOT NULL
       GROUP BY c.id ORDER BY c.deleted_at DESC`
    ),
    c.env.DB.prepare(
      `SELECT p.*, c.title AS collection_title
       FROM photos p JOIN collections c ON c.id = p.collection_id
       WHERE p.deleted_at IS NOT NULL AND c.deleted_at IS NULL
       ORDER BY p.deleted_at DESC`
    ),
  ])
  return c.json({ collections, photos })
})

app.post('/api/trash/collections/:id/restore', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const col = await c.env.DB.prepare('SELECT id, purge_started_at FROM collections WHERE id = ? AND deleted_at IS NOT NULL').bind(id).first()
  if (!col) return c.json({ error: 'not found in trash' }, 404)
  if (col.purge_started_at) return c.json({ error: 'permanent deletion is in progress; retry permanent deletion' }, 409)
  await c.env.DB.prepare('UPDATE collections SET deleted_at = NULL WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

app.post('/api/trash/photos/:id/restore', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const photo = await c.env.DB.prepare(
    `SELECT p.id, p.collection_id, p.purge_started_at, c.deleted_at AS collection_deleted_at
     FROM photos p JOIN collections c ON c.id = p.collection_id
     WHERE p.id = ? AND p.deleted_at IS NOT NULL`
  ).bind(id).first()
  if (!photo) return c.json({ error: 'not found in trash' }, 404)
  if (photo.purge_started_at) return c.json({ error: 'permanent deletion is in progress; retry permanent deletion' }, 409)
  if (photo.collection_deleted_at) return c.json({ error: 'restore the collection first' }, 409)
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE photos SET deleted_at = NULL WHERE id = ?').bind(id),
    c.env.DB.prepare('UPDATE collections SET cover_photo_id = COALESCE(cover_photo_id, ?) WHERE id = ?')
      .bind(id, photo.collection_id),
  ])
  return c.json({ ok: true })
})

async function deleteR2Keys(bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000))
}

app.delete('/api/trash/collections/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const col = await c.env.DB.prepare('SELECT id FROM collections WHERE id = ? AND deleted_at IS NOT NULL').bind(id).first()
  if (!col) return c.json({ error: 'not found in trash' }, 404)
  await c.env.DB.prepare('UPDATE collections SET purge_started_at = COALESCE(purge_started_at, ?) WHERE id = ?')
    .bind(new Date().toISOString(), id).run()
  const { results: photos } = await c.env.DB.prepare(
    'SELECT key_large, key_thumb FROM photos WHERE collection_id = ?'
  ).bind(id).all()
  const keys = photos.flatMap((p) => [p.key_large, p.key_thumb])
  await deleteR2Keys(c.env.PHOTOS, keys)
  if (c.req.query('purge_backups') === '1') await removeKeysFromBackups(c.env.PHOTOS, keys)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM photos WHERE collection_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM groups WHERE collection_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(id),
    c.env.DB.prepare("UPDATE settings SET value = '' WHERE key = 'featured_collection_id' AND value = ?").bind(String(id)),
  ])
  return c.json({ ok: true })
})

app.delete('/api/trash/photos/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const photo = await c.env.DB.prepare('SELECT * FROM photos WHERE id = ? AND deleted_at IS NOT NULL').bind(id).first()
  if (!photo) return c.json({ error: 'not found in trash' }, 404)
  await c.env.DB.prepare('UPDATE photos SET purge_started_at = COALESCE(purge_started_at, ?) WHERE id = ?')
    .bind(new Date().toISOString(), id).run()
  await deleteR2Keys(c.env.PHOTOS, [photo.key_large, photo.key_thumb])
  if (c.req.query('purge_backups') === '1') {
    await removeKeysFromBackups(c.env.PHOTOS, [photo.key_large, photo.key_thumb])
  }
  await c.env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

// ---------- groups (컬렉션 안의 사람별 폴더) ----------
app.post('/api/collections/:id/groups', requireAdmin, async (c) => {
  const collectionId = c.req.param('id')
  const col = await c.env.DB.prepare('SELECT id FROM collections WHERE id = ? AND deleted_at IS NULL')
    .bind(collectionId).first()
  if (!col) return c.json({ error: 'collection not found' }, 404)
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
  const meta = parseJsonObject(g.meta_json)
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
  if ('cover_photo_id' in body && body.cover_photo_id != null) {
    const photo = await c.env.DB.prepare(
      'SELECT id FROM photos WHERE id = ? AND collection_id = ? AND deleted_at IS NULL'
    ).bind(body.cover_photo_id, id).first()
    if (!photo) return c.json({ error: 'cover photo does not belong to collection' }, 400)
  }
  const fields = ['title', 'date', 'description', 'cover_photo_id', 'published']
  const sets = [], vals = []
  for (const f of fields) {
    if (f in body) {
      if (f === 'published' && ![0, 1, false, true].includes(body[f])) return c.json({ error: 'published must be boolean' }, 400)
      sets.push(`${f} = ?`)
      vals.push(f === 'published' ? (body[f] ? 1 : 0) : body[f])
    }
  }
  if (!sets.length) return c.json({ error: 'no fields' }, 400)
  const result = await c.env.DB.prepare(`UPDATE collections SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`)
    .bind(...vals, id).run()
  if (!result.meta.changes) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

app.delete('/api/collections/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const col = await c.env.DB.prepare('SELECT id FROM collections WHERE id = ? AND deleted_at IS NULL').bind(id).first()
  if (!col) return c.json({ error: 'not found' }, 404)
  const deletedAt = new Date().toISOString()
  await c.env.DB.prepare('UPDATE collections SET deleted_at = ? WHERE id = ?').bind(deletedAt, id).run()
  return c.json({ ok: true })
})

// ---------- photos ----------
export async function persistUpload({ bucket, keyLarge, keyThumb, large, thumb, insertPhoto }) {
  const storedKeys = []
  try {
    await bucket.put(keyLarge, large.stream(), { httpMetadata: { contentType: large.type } })
    storedKeys.push(keyLarge)
    await bucket.put(keyThumb, thumb.stream(), { httpMetadata: { contentType: thumb.type } })
    storedKeys.push(keyThumb)
    return await insertPhoto()
  } catch (error) {
    if (storedKeys.length) {
      try { await bucket.delete(storedKeys) } catch (cleanupError) {
        console.error(JSON.stringify({ message: 'upload rollback failed', keys: storedKeys, error: String(cleanupError) }))
      }
    }
    throw error
  }
}

app.post('/api/collections/:id/photos', requireAdmin, async (c) => {
  const collectionId = c.req.param('id')
  const col = await c.env.DB.prepare('SELECT id, cover_photo_id FROM collections WHERE id = ? AND deleted_at IS NULL')
    .bind(collectionId).first()
  if (!col) return c.json({ error: 'collection not found' }, 404)

  const form = await c.req.formData()
  const large = form.get('large')
  const thumb = form.get('thumb')
  if (!large || !thumb || typeof large === 'string' || typeof thumb === 'string') {
    return c.json({ error: 'large and thumb files required' }, 400)
  }
  const allowedTypes = new Set(['image/jpeg', 'image/webp'])
  if (!allowedTypes.has(large.type) || !allowedTypes.has(thumb.type)) {
    return c.json({ error: 'only JPEG and WebP images are allowed' }, 415)
  }
  if (large.size > 16 * 1024 * 1024 || thumb.size > 2 * 1024 * 1024) {
    return c.json({ error: 'image file is too large' }, 413)
  }
  const hasImageSignature = async (file) => {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    if (file.type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  }
  if (!(await hasImageSignature(large)) || !(await hasImageSignature(thumb))) {
    return c.json({ error: 'image content does not match its file type' }, 415)
  }

  const width = parseInt(form.get('width') || '0', 10)
  const height = parseInt(form.get('height') || '0', 10)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 20000 || height > 20000) {
    return c.json({ error: 'invalid image dimensions' }, 400)
  }
  const takenAt = String(form.get('taken_at') || '')
  const exifRaw = String(form.get('exif') || '{}')
  if (exifRaw.length > 64 * 1024) return c.json({ error: 'exif metadata is too large' }, 413)
  let parsedExif
  try { parsedExif = JSON.parse(exifRaw) } catch { return c.json({ error: 'invalid exif JSON' }, 400) }
  if (!parsedExif || typeof parsedExif !== 'object' || Array.isArray(parsedExif)) {
    return c.json({ error: 'exif metadata must be an object' }, 400)
  }
  const exifJson = JSON.stringify(parsedExif)
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
  const { meta } = await persistUpload({
    bucket: c.env.PHOTOS,
    keyLarge,
    keyThumb,
    large,
    thumb,
    insertPhoto: () => c.env.DB.prepare(
      `INSERT INTO photos (collection_id, group_id, key_large, key_thumb, width, height, taken_at, exif_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(collectionId, groupId, keyLarge, keyThumb, width, height, takenAt, exifJson).run(),
  })

  // 첫 사진이면 자동으로 대표 지정
  if (!col.cover_photo_id) {
    try {
      await c.env.DB.prepare('UPDATE collections SET cover_photo_id = ? WHERE id = ? AND cover_photo_id IS NULL')
        .bind(meta.last_row_id, collectionId).run()
    } catch (error) {
      // 사진과 DB 행은 이미 일관된 상태이므로 업로드를 실패로 돌리지 않고 다음 관리 작업에서 복구합니다.
      console.error(JSON.stringify({ message: 'cover assignment failed', collectionId, photoId: meta.last_row_id, error: String(error) }))
    }
  }
  return c.json({ id: meta.last_row_id, key_large: keyLarge, key_thumb: keyThumb })
})

// 사진을 다른 폴더로 이동 (group_id: null = 컬렉션 바로 아래)
app.patch('/api/photos/:id', requireAdmin, async (c) => {
  const { group_id = null } = await c.req.json()
  const photo = await c.env.DB.prepare('SELECT collection_id FROM photos WHERE id = ? AND deleted_at IS NULL')
    .bind(c.req.param('id')).first()
  if (!photo) return c.json({ error: 'not found' }, 404)
  if (group_id != null) {
    const group = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ? AND collection_id = ?')
      .bind(group_id, photo.collection_id).first()
    if (!group) return c.json({ error: 'group does not belong to collection' }, 400)
  }
  await c.env.DB.prepare('UPDATE photos SET group_id = ? WHERE id = ?')
    .bind(group_id, c.req.param('id')).run()
  return c.json({ ok: true })
})

app.delete('/api/photos/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const photo = await c.env.DB.prepare('SELECT * FROM photos WHERE id = ? AND deleted_at IS NULL').bind(id).first()
  if (!photo) return c.json({ error: 'not found' }, 404)
  await c.env.DB.prepare('UPDATE photos SET deleted_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), id).run()
  // 대표 사진이었으면 다른 사진으로 교체
  const col = await c.env.DB.prepare('SELECT cover_photo_id FROM collections WHERE id = ?')
    .bind(photo.collection_id).first()
  if (col && col.cover_photo_id === photo.id) {
    const next = await c.env.DB.prepare(
      'SELECT id FROM photos WHERE collection_id = ? AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1'
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
  const type = (res.headers.get('Content-Type') || '').split(';')[0].toLowerCase()
  if (!['image/jpeg', 'image/webp'].includes(type)) return c.text('unsupported image type', 415)
  const length = Number(res.headers.get('Content-Length') || 0)
  if (length > 20 * 1024 * 1024) return c.text('image is too large', 413)
  const body = await res.arrayBuffer()
  if (body.byteLength > 20 * 1024 * 1024) return c.text('image is too large', 413)
  return new Response(body, {
    headers: { 'Content-Type': type, 'Content-Length': String(body.byteLength), 'Cache-Control': 'no-store' },
  })
})

// ---------- OG 태그 (트위터/카톡 공유 미리보기 카드) ----------
// 문구는 public/config.js와 맞춰서 관리
const OG_TITLE = 'Moments Kept in Light'
const OG_DESC = 'The moments we met, frame by frame.'

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch])
}

app.get('/share/collection/:id', async (c) => {
  const id = c.req.param('id')
  const col = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.description, p.key_large
     FROM collections c
     LEFT JOIN photos p ON p.id = c.cover_photo_id AND p.deleted_at IS NULL
     WHERE c.id = ? AND c.published = 1 AND c.deleted_at IS NULL`
  ).bind(id).first()
  if (!col) return c.text('not found', 404)
  if (!col.key_large) {
    const first = await c.env.DB.prepare(
      'SELECT key_large FROM photos WHERE collection_id = ? AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1'
    ).bind(id).first()
    col.key_large = first?.key_large || null
  }
  const origin = new URL(c.req.url).origin
  const shareUrl = `${origin}/share/collection/${id}`
  const galleryUrl = `${origin}/#/c/${id}`
  const imageUrl = col.key_large ? `${origin}/img/${col.key_large}` : `${origin}/og.png`
  const title = col.title || OG_TITLE
  const description = col.description || OG_DESC
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)} · ${escapeHtml(OG_TITLE)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(shareUrl)}" />
<meta property="og:image" content="${escapeHtml(imageUrl)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
<link rel="canonical" href="${escapeHtml(galleryUrl)}" />
<meta http-equiv="refresh" content="0;url=${escapeHtml(galleryUrl)}" />
</head><body><p><a href="${escapeHtml(galleryUrl)}">컬렉션 보기</a></p>
<script>location.replace(${JSON.stringify(galleryUrl)})</script></body></html>`
  return c.html(html, 200, { 'Cache-Control': 'public, max-age=300' })
})

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
  const photo = await c.env.DB.prepare(
    `SELECT p.id, p.deleted_at, col.published, col.deleted_at AS collection_deleted_at
     FROM photos p JOIN collections col ON col.id = p.collection_id
     WHERE p.key_large = ? OR p.key_thumb = ? LIMIT 1`
  ).bind(key, key).first()
  if (!photo) return c.text('not found', 404)
  const admin = await isAdmin(c)
  if (!admin && (photo.deleted_at || photo.collection_deleted_at || photo.published !== 1)) return c.text('not found', 404)
  const obj = await c.env.PHOTOS.get(key)
  if (!obj) return c.text('not found', 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/webp',
      'Cache-Control': admin ? 'private, no-store' : 'public, max-age=300, must-revalidate',
      ETag: obj.httpEtag,
    },
  })
})

export default app
