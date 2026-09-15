import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

const app = new Hono()

// ---------- auth ----------
const textEncoder = new TextEncoder()
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_LOGIN_FAILURES = 5
const SHOOT_TYPES = new Set(['event', 'session'])
const LOCATION_TYPES = new Set(['', 'venue', 'outdoor', 'studio'])
const HOME_SECTION_ORDERS = new Set(['events_first', 'sessions_first'])

function nullablePositiveInteger(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

async function collectionTypeFields(db, body, existing = {}, selfId = null) {
  const shootType = body.shoot_type === undefined ? (existing.shoot_type || 'event') : body.shoot_type
  const locationType = body.location_type === undefined ? (existing.location_type || '') : body.location_type
  const relationProvided = Object.prototype.hasOwnProperty.call(body, 'related_event_id')
  // 행사로 바꾸면 남아 있던 관련 행사 연결은 자동으로 끊습니다.
  const relatedEventId = relationProvided
    ? nullablePositiveInteger(body.related_event_id)
    : shootType === 'event' ? null : (existing.related_event_id || null)

  if (!SHOOT_TYPES.has(shootType)) return { error: 'shoot_type must be event or session' }
  if (!LOCATION_TYPES.has(locationType)) return { error: 'invalid location_type' }
  if (relatedEventId === undefined) return { error: 'related_event_id must be a positive integer or null' }
  if (shootType === 'event' && relatedEventId != null) return { error: 'events cannot have a related event' }
  if (relatedEventId != null) {
    const related = await db.prepare(
      `SELECT id FROM collections
       WHERE id = ? AND id != ? AND shoot_type = 'event' AND deleted_at IS NULL`
    ).bind(relatedEventId, selfId || 0).first()
    if (!related) return { error: 'related event not found' }
  }
  return { shootType, locationType, relatedEventId }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function listMetaValues(value, separator = /[,\s]+/) {
  const values = Array.isArray(value) ? value : String(value || '').split(separator)
  return values.map((item) => String(item || '').trim()).filter(Boolean)
}

function normalizeSessionModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const model = {
    name: String(value.name || '').trim(),
    twitter: listMetaValues(value.twitter).map((handle) => handle.replace(/^@/, '')).filter(Boolean),
    character: String(value.character || '').trim(),
    series: listMetaValues(value.series, /[,\n]+/).map(normalizeSeries).filter(Boolean),
  }
  return model.name || model.twitter.length || model.character || model.series.length ? model : null
}

function sessionModelOf(meta) {
  return normalizeSessionModel(meta?.session_model)
}

function resolvedSessionModelNames(model, handles, modelNames) {
  const parts = String(model?.name || '').split('&').map((part) => part.trim()).filter(Boolean)
  return handles.map((handle, index) =>
    modelNames[handle.toLowerCase()] || (handles.length === 1 ? model?.name || '' : parts[index] || '')
  )
}

// 작품명 표기 통일. 같은 작품이 공백 차이로 갈라지지 않게 합니다.
// 예: '승리의 여신 : 니케' → '승리의 여신: 니케' (공식 표기)
export function normalizeSeries(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*/g, ': ')
    .trim()
}
// '작품 - 캐릭터' 한 줄을 작품과 캐릭터로 나눕니다.
// 구분자가 없으면 괄호 앞 이름을 그 자체로 작품으로 씁니다(오리지널·보컬로이드 계열).
export function splitCharacterLine(raw) {
  const text = String(raw || '').trim()
  if (!text) return { series: '', character: '' }
  const parts = text.split(/\s+[-–—]\s+/)
  if (parts.length >= 2) {
    return { series: normalizeSeries(parts[0]), character: parts.slice(1).join(' - ').trim() }
  }
  return { series: normalizeSeries(text.replace(/\s*[（(].*$/, '')), character: text }
}

// 폴더 메타에서 작품 목록을 얻습니다. series가 아직 없는 예전 데이터는 캐릭터명에서 유도합니다.
export function seriesOf(meta) {
  const stored = Array.isArray(meta?.series) ? meta.series.map(normalizeSeries).filter(Boolean) : []
  if (stored.length) return stored
  const derived = splitCharacterLine(meta?.character).series
  return derived ? [derived] : []
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
// 집계 제외 쿠키. `/?nostat=1` 로 한 번 접속하면 이후 그 브라우저의 방문은 세지 않습니다.
// (본인 확인용 방문이나 개발 중 반복 접속이 통계를 부풀리지 않게 합니다. `/?nostat=0` 으로 해제)
const NOSTAT_COOKIE = 'nostat'
function applyNostatPreference(c) {
  const wanted = c.req.query('nostat')
  if (wanted === '1') {
    setCookie(c, NOSTAT_COOKIE, '1', {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    })
    return true
  }
  if (wanted === '0') {
    deleteCookie(c, NOSTAT_COOKIE, { path: '/' })
    return false
  }
  return getCookie(c, NOSTAT_COOKIE) === '1'
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

// 공개 GET 응답을 짧게 캐시합니다. 뒤로가기·재방문 때 같은 목록을 다시 받지 않아
// 화면이 즉시 그려집니다. 관리자 응답에는 비공개 초안이 섞이므로 저장하지 않습니다.
// Vary: Cookie — 로그인 여부에 따라 내용이 달라지므로 캐시를 섞지 않게 합니다.
function apiCacheHeaders(includeDrafts) {
  return includeDrafts
    ? { 'Cache-Control': 'private, no-store' }
    : { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300', Vary: 'Cookie' }
}

// ---------- collections ----------
app.get('/api/collections', async (c) => {
  const includeDrafts = await isAdmin(c)
  const visibility = includeDrafts ? 'col.deleted_at IS NULL' : 'col.deleted_at IS NULL AND col.published = 1'
  const { results } = await c.env.DB.prepare(
    `SELECT col.*, p.key_thumb AS cover_thumb, p.key_large AS cover_large, p.key_medium AS cover_medium,
            p.width AS cover_w, p.height AS cover_h, p.group_id AS cover_group,
            (SELECT COUNT(*) FROM photos WHERE collection_id = col.id AND deleted_at IS NULL) AS photo_count,
            (SELECT key_thumb FROM photos WHERE collection_id = col.id AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_thumb,
            (SELECT key_large FROM photos WHERE collection_id = col.id AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_large,
            (SELECT key_medium FROM photos WHERE collection_id = col.id AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_medium,
            (SELECT width FROM photos WHERE collection_id = col.id AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_w,
            (SELECT height FROM photos WHERE collection_id = col.id AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS first_h,
            related.title AS related_event_title, related.date AS related_event_date
     FROM collections col
     LEFT JOIN collections related ON related.id = col.related_event_id
       AND related.deleted_at IS NULL AND related.shoot_type = 'event'
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
    if (r.shoot_type === 'session') r.session_model = sessionModelOf(parseJsonObject(r.meta_json))
    r.cover_thumb = r.cover_thumb || r.first_thumb
    r.cover_large = r.cover_large || r.first_large
    // medium이 없는 예전 사진은 large로 폴백합니다.
    r.cover_medium = r.cover_medium || r.first_medium || r.cover_large
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
  return c.json(results, 200, apiCacheHeaders(includeDrafts))
})

app.post('/api/collections', requireAdmin, async (c) => {
  const body = await c.req.json()
  const { title, date = '', description = '' } = body
  if (!title) return c.json({ error: 'title required' }, 400)
  const typeFields = await collectionTypeFields(c.env.DB, body)
  if (typeFields.error) return c.json({ error: typeFields.error }, 400)
  const sessionModel = typeFields.shootType === 'session' ? normalizeSessionModel(body.session_model) : null
  const { meta } = await c.env.DB.prepare(
    `INSERT INTO collections
       (title, date, description, meta_json, published, shoot_type, location_type, related_event_id)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
  ).bind(title, date, description, JSON.stringify(sessionModel ? { session_model: sessionModel } : {}), typeFields.shootType, typeFields.locationType, typeFields.relatedEventId).run()
  return c.json({ id: meta.last_row_id })
})

app.get('/api/collections/:id', async (c) => {
  const id = c.req.param('id')
  const includeDrafts = await isAdmin(c)
  const col = await c.env.DB.prepare(
    `SELECT col.*, related.title AS related_event_title, related.date AS related_event_date
     FROM collections col
     LEFT JOIN collections related ON related.id = col.related_event_id
       AND related.deleted_at IS NULL AND related.shoot_type = 'event'
     WHERE col.id = ? AND col.deleted_at IS NULL${includeDrafts ? '' : ' AND col.published = 1'}`
  ).bind(id).first()
  if (!col) return c.json({ error: 'not found' }, 404)
  const { results: photos } = await c.env.DB.prepare(
    'SELECT * FROM photos WHERE collection_id = ? AND deleted_at IS NULL ORDER BY (sort_order IS NULL), sort_order, taken_at, id'
  ).bind(id).all()
  for (const p of photos) p.exif = parseJsonObject(p.exif_json)
  const { results: groups } = await c.env.DB.prepare(
    'SELECT * FROM groups WHERE collection_id = ? ORDER BY (sort_order IS NULL), sort_order, id'
  ).bind(id).all()
  for (const g of groups) {
    g.meta = parseJsonObject(g.meta_json)
    g.series = seriesOf(g.meta) // series 미설정 폴더는 캐릭터명에서 유도
  }
  const { results: modelNameRows } = await c.env.DB.prepare('SELECT handle, name FROM model_names').all()
  const modelNames = Object.fromEntries(modelNameRows.map((row) => [row.handle.toLowerCase(), row.name]))
  col.session_model = sessionModelOf(parseJsonObject(col.meta_json))
  for (const g of groups) {
    const handles = [].concat(g.meta.twitter || [])
    g.model_names = handles.map((handle) => modelNames[handle.toLowerCase()] || (handles.length === 1 ? g.name : ''))
  }
  return c.json({ ...col, photos, groups }, 200, apiCacheHeaders(includeDrafts))
})

// ---------- 수동 정렬 저장 ----------
// id마다 UPDATE 한 문장을 만들면 사진 500장 컬렉션에서 한 번 끌 때 500개 문장이 나갑니다.
// CASE 한 문장으로 묶고, SQL이 과도하게 길어지지 않게 청크로 나눕니다.
const ORDER_CHUNK = 200
function orderStatements(db, table, ids, scope) {
  const statements = []
  for (let start = 0; start < ids.length; start += ORDER_CHUNK) {
    const chunk = ids.slice(start, start + ORDER_CHUNK)
    const cases = chunk.map(() => 'WHEN ? THEN ?').join(' ')
    const placeholders = chunk.map(() => '?').join(',')
    const values = chunk.flatMap((id, i) => [id, start + i])
    statements.push(db.prepare(
      `UPDATE ${table} SET sort_order = CASE id ${cases} END
       WHERE id IN (${placeholders})${scope ? ' AND collection_id = ?' : ''}`
    ).bind(...values, ...chunk, ...(scope ? [scope] : [])))
  }
  return statements
}
function parseOrderIds(body) {
  if (!Array.isArray(body?.ids) || !body.ids.length) return null
  const ids = body.ids.map((id) => Number(id))
  return ids.every((id) => Number.isInteger(id) && id > 0) ? ids : null
}

// 컬렉션 순서: 전체 컬렉션 id를 표시 순서대로 받아 저장
app.put('/api/collection-order', requireAdmin, async (c) => {
  const ids = parseOrderIds(await c.req.json())
  if (!ids) return c.json({ error: 'ids required' }, 400)
  await c.env.DB.batch(orderStatements(c.env.DB, 'collections', ids, null))
  return c.json({ ok: true })
})

// 사진 순서: 컬렉션 내 전체 사진 id를 표시 순서대로 받아 저장
app.put('/api/collections/:id/photo-order', requireAdmin, async (c) => {
  const ids = parseOrderIds(await c.req.json())
  if (!ids) return c.json({ error: 'ids required' }, 400)
  await c.env.DB.batch(orderStatements(c.env.DB, 'photos', ids, c.req.param('id')))
  return c.json({ ok: true })
})

// 폴더(사람) 순서
app.put('/api/collections/:id/group-order', requireAdmin, async (c) => {
  const ids = parseOrderIds(await c.req.json())
  if (!ids) return c.json({ error: 'ids required' }, 400)
  await c.env.DB.batch(orderStatements(c.env.DB, 'groups', ids, c.req.param('id')))
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
    g.series = seriesOf(metadata)
  }
  return { groups, cols, aliases, names }
}

// 모델 표시 이름 규칙(사이트 전체 공통): 등록 이름 → 그 모델 단독 폴더 이름 → @핸들.
// 닉네임을 주로 보여주고 계정은 보조로 두기 때문에, 어느 화면에서든 같은 이름이 나와야 합니다.
function modelNameResolver(groups, names, aliases) {
  const fromFolder = {}
  // 합동 폴더 이름은 '선혈 & 마요'처럼 닉네임을 &로 이어 씁니다.
  // 쪼갠 조각 수가 핸들 수와 같을 때만 순서대로 짝지어 이름을 얻습니다.
  for (const g of groups) {
    if (g.handles.length < 2) continue
    const parts = g.name.split('&').map((part) => part.trim()).filter(Boolean)
    if (parts.length !== g.handles.length) continue
    g.handles.forEach((handle, index) => {
      const key = handle.toLowerCase()
      if (!fromFolder[key]) fromFolder[key] = parts[index]
    })
  }
  // 단독 폴더 이름이 더 확실하므로 나중에 덮어씁니다.
  for (const g of groups) {
    if (g.handles.length !== 1) continue
    fromFolder[g.handles[0].toLowerCase()] = g.name
  }
  return (handle) => {
    const key = String(handle || '').toLowerCase()
    const canon = aliases ? resolveAlias(aliases, key) : key
    return names[canon] || names[key] || fromFolder[canon] || fromFolder[key] || '@' + handle
  }
}

// 모델 목록: 핸들 기준 자동 집계 (별칭 병합)
// 통합 검색용 색인. 작품·캐릭터·모델·행사를 한 번에 내려 클라이언트가 즉시 필터링합니다.
// (지금 규모에서는 입력마다 서버를 왕복하지 않는 쪽이 훨씬 빠릅니다)
app.get('/api/search-index', async (c) => {
  const includeDrafts = await isAdmin(c)
  const visible = includeDrafts ? '' : ' AND col.published = 1'
  const [groupRes, colRes, nameRes, aliasRes, searchAliasRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT g.id, g.name, g.meta_json, g.collection_id, col.title AS collection_title,
              (SELECT COUNT(*) FROM photos WHERE group_id = g.id AND deleted_at IS NULL) AS photo_count,
              (SELECT key_thumb FROM photos WHERE group_id = g.id AND deleted_at IS NULL
                ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS thumb
       FROM groups g JOIN collections col ON col.id = g.collection_id
       WHERE col.deleted_at IS NULL${visible}`
    ),
    c.env.DB.prepare(
      `SELECT col.id, col.title, col.date,
              (SELECT COUNT(*) FROM photos WHERE collection_id = col.id AND deleted_at IS NULL) AS photo_count,
              (SELECT key_thumb FROM photos WHERE collection_id = col.id AND deleted_at IS NULL
                ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1) AS thumb
       FROM collections col
       WHERE col.deleted_at IS NULL${includeDrafts ? '' : ' AND col.published = 1'}
       ORDER BY (col.sort_order IS NOT NULL), col.sort_order, col.date DESC, col.id ASC`
    ),
    c.env.DB.prepare('SELECT handle, name FROM model_names'),
    c.env.DB.prepare('SELECT old_handle, new_handle FROM model_aliases'),
    c.env.DB.prepare('SELECT kind, target, alias FROM search_aliases'),
  ])
  const names = Object.fromEntries((nameRes.results || []).map((r) => [r.handle.toLowerCase(), r.name]))
  const aliases = {}
  for (const a of aliasRes.results || []) aliases[a.old_handle.toLowerCase()] = a.new_handle
  // 검색 별칭: 공식명이 영어여도 통칭(서코·플엑 등)으로 찾히게 합니다.
  const aliasBy = { collection: {}, series: {}, model: {} }
  for (const row of searchAliasRes.results || []) {
    const bucket = aliasBy[row.kind]
    if (!bucket) continue
    ;(bucket[String(row.target).toLowerCase()] ||= []).push(row.alias)
  }
  const aliasesFor = (kind, target) => aliasBy[kind][String(target).toLowerCase()] || []
  // 모델 표시 이름은 사이트 전체와 같은 규칙을 씁니다.
  const displayName = modelNameResolver(
    (groupRes.results || []).map((g) => ({ name: g.name, handles: [].concat(parseJsonObject(g.meta_json).twitter || []) })),
    names,
    aliases
  )

  const characters = []
  const seriesMap = new Map()
  const modelMap = new Map()
  for (const g of groupRes.results || []) {
    const meta = parseJsonObject(g.meta_json)
    const series = seriesOf(meta)
    const handles = [].concat(meta.twitter || [])
    if (meta.character) {
      characters.push({
        character: meta.character,
        series,
        collection_id: g.collection_id,
        collection_title: g.collection_title,
        group_id: g.id,
        photo_count: g.photo_count,
        thumb: g.thumb,
        models: handles,
      })
    }
    for (const s of series) {
      const entry = seriesMap.get(s) || { name: s, character_count: 0, photo_count: 0, thumb: null }
      entry.character_count++
      entry.photo_count += g.photo_count
      entry.thumb = entry.thumb || g.thumb
      seriesMap.set(s, entry)
    }
    for (const raw of handles) {
      const canon = resolveAlias(aliases, raw.toLowerCase())
      const entry = modelMap.get(canon) || { handle: canon, name: displayName(raw), photo_count: 0, thumb: null }
      entry.photo_count += g.photo_count
      entry.thumb = entry.thumb || g.thumb
      // 단독 폴더 이름은 등록 이름이 없을 때의 표시 이름으로 씁니다.
      modelMap.set(canon, entry)
    }
  }
  // 별칭을 각 항목에 붙여 클라이언트가 통칭으로도 찾을 수 있게 합니다.
  const series = [...seriesMap.values()].sort((a, b) => b.photo_count - a.photo_count)
  series.forEach((s) => { s.aliases = aliasesFor('series', s.name) })
  const models = [...modelMap.values()].sort((a, b) => b.photo_count - a.photo_count)
  models.forEach((m) => { m.aliases = aliasesFor('model', m.handle) })
  // 행사 별칭은 이름 기준입니다. 같은 이름의 다른 회차도 같은 검색어로 찾히게 하려는 것입니다.
  const collections = (colRes.results || []).map((col) => ({ ...col, aliases: aliasesFor('collection', col.title) }))
  return c.json({
    series,
    characters: characters.sort((a, b) => b.photo_count - a.photo_count),
    models,
    collections,
  }, 200, apiCacheHeaders(includeDrafts))
})

app.get('/api/models', async (c) => {
  const includeDrafts = await isAdmin(c)
  const { groups, cols, aliases, names } = await loadModelBase(c.env.DB, includeDrafts)
  const displayName = modelNameResolver(groups, names, aliases)
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
    name: names[canon] || m.soloName || displayName(m.handle),
    photo_count: m.photo_count,
    collection_count: m.cols.size,
    cover_thumb: m.best && m.best.thumb,
    _ord: m.best ? m.best.ord : 999,
  })).sort((a, b) => a._ord - b._ord)
  out.forEach((m) => delete m._ord)
  return c.json(out, 200, apiCacheHeaders(includeDrafts))
})

// 모델 상세: 행사별 섹션으로 사진 묶음
// 대표사진 고를 때 보여줄, 그 작품에 속한 사진들 (admin)
app.get('/api/series-photos', requireAdmin, async (c) => {
  const name = normalizeSeries(c.req.query('name') || '')
  if (!name) return c.json({ error: 'name required' }, 400)
  const { results: groups } = await c.env.DB.prepare('SELECT id, meta_json FROM groups').all()
  const ids = groups.filter((g) => seriesOf(parseJsonObject(g.meta_json)).includes(name)).map((g) => g.id)
  if (!ids.length) return c.json({ photos: [] })
  const { results } = await c.env.DB.prepare(
    `SELECT id, key_thumb FROM photos
     WHERE deleted_at IS NULL AND group_id IN (${ids.map(() => '?').join(',')})
     ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 200`
  ).bind(...ids).all()
  const current = await c.env.DB.prepare('SELECT cover_photo_id FROM series_meta WHERE name = ?').bind(name).first()
  return c.json({ photos: results, cover_photo_id: current?.cover_photo_id ?? null })
})

// 작품 대표사진 지정 (admin). photo_id를 비우면 지정을 해제해 첫 사진으로 돌아갑니다.
app.put('/api/series-cover', requireAdmin, async (c) => {
  const body = await c.req.json()
  const name = normalizeSeries(body.name || '')
  if (!name) return c.json({ error: 'name required' }, 400)
  const photoId = body.photo_id == null || body.photo_id === '' ? null : Number(body.photo_id)
  if (photoId != null && !Number.isInteger(photoId)) return c.json({ error: 'invalid photo_id' }, 400)
  if (photoId == null) {
    await c.env.DB.prepare('DELETE FROM series_meta WHERE name = ?').bind(name).run()
    return c.json({ ok: true, cover_photo_id: null })
  }
  const photo = await c.env.DB.prepare('SELECT id FROM photos WHERE id = ? AND deleted_at IS NULL').bind(photoId).first()
  if (!photo) return c.json({ error: 'photo not found' }, 404)
  await c.env.DB.prepare(
    `INSERT INTO series_meta (name, cover_photo_id) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET cover_photo_id = excluded.cover_photo_id`
  ).bind(name, photoId).run()
  return c.json({ ok: true, cover_photo_id: photoId })
})

// ---------- 검색 별칭 관리 (admin) ----------
// 공식명이 영어인 행사(Comic World → 서코·부코·수코), 긴 작품명(승리의 여신: 니케 → 니케) 등을
// 사람들이 실제로 쓰는 말로 찾을 수 있게 합니다.
const ALIAS_KINDS = new Set(['collection', 'series', 'model'])

app.get('/api/search-aliases', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT kind, target, alias FROM search_aliases ORDER BY kind, target, alias'
  ).all()
  return c.json(results)
})

app.post('/api/search-aliases', requireAdmin, async (c) => {
  const body = await c.req.json()
  const kind = String(body.kind || '')
  const target = String(body.target || '').trim()
  if (!ALIAS_KINDS.has(kind) || !target) return c.json({ error: 'kind and target required' }, 400)
  // 쉼표로 여러 개를 한 번에 등록할 수 있습니다.
  const list = [...new Set(String(body.alias || '').split(',').map((a) => a.trim()).filter(Boolean))]
  if (!list.length) return c.json({ error: 'alias required' }, 400)
  if (list.some((a) => a.length > 40)) return c.json({ error: 'alias is too long' }, 400)
  await c.env.DB.batch(list.map((alias) =>
    c.env.DB.prepare('INSERT OR IGNORE INTO search_aliases (kind, target, alias) VALUES (?, ?, ?)')
      .bind(kind, target, alias)))
  return c.json({ ok: true, added: list.length })
})

app.delete('/api/search-aliases', requireAdmin, async (c) => {
  const kind = c.req.query('kind') || ''
  const target = c.req.query('target') || ''
  const alias = c.req.query('alias') || ''
  if (!ALIAS_KINDS.has(kind) || !target || !alias) return c.json({ error: 'kind, target, alias required' }, 400)
  const result = await c.env.DB.prepare('DELETE FROM search_aliases WHERE kind = ? AND target = ? AND alias = ?')
    .bind(kind, target, alias).run()
  if (!result.meta.changes) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

// ---------- 캐릭터 아카이브 ----------
// 작품별로 묶은 캐릭터 목록. 같은 캐릭터가 여러 행사에 있으면 한 항목으로 합칩니다.
app.get('/api/characters', async (c) => {
  const includeDrafts = await isAdmin(c)
  const { groups, cols, names, aliases } = await loadModelBase(c.env.DB, includeDrafts)
  const displayName = modelNameResolver(groups, names, aliases)
  // 폴더별 사진 수 + 표시 순서상 첫 썸네일을 한 번에 (폴더 수만큼만 행이 나옵니다)
  const { results: counts } = await c.env.DB.prepare(
    `SELECT group_id, n, key_thumb AS thumb FROM (
       SELECT group_id, key_thumb,
              COUNT(*) OVER (PARTITION BY group_id) AS n,
              ROW_NUMBER() OVER (PARTITION BY group_id
                ORDER BY (sort_order IS NULL), sort_order, taken_at, id) AS rn
       FROM photos WHERE deleted_at IS NULL AND group_id IS NOT NULL
     ) WHERE rn = 1`
  ).all()
  const countByGroup = Object.fromEntries(counts.map((r) => [r.group_id, r]))
  const colOrder = Object.fromEntries(cols.map((col, i) => [col.id, i]))
  // 작품 대표사진: 관리자가 지정한 사진이 있으면 그걸 씁니다(없으면 아래에서 첫 사진).
  const { results: coverRows } = await c.env.DB.prepare(
    `SELECT sm.name, p.key_thumb AS thumb FROM series_meta sm
     JOIN photos p ON p.id = sm.cover_photo_id AND p.deleted_at IS NULL`
  ).all()
  const seriesCover = Object.fromEntries(coverRows.map((r) => [r.name, r.thumb]))

  // 캐릭터 키는 이름 그대로 씁니다(의상 버전이 다르면 다른 항목으로 두는 편이 자연스럽습니다).
  const byCharacter = new Map()
  for (const g of groups) {
    if (!g.character) continue
    const stat = countByGroup[g.id]
    if (!stat || !stat.n) continue
    const entry = byCharacter.get(g.character) || {
      character: g.character, series: [], photo_count: 0, thumb: null,
      models: [], collection_id: null, group_id: null, _ord: Infinity,
    }
    entry.photo_count += stat.n
    for (const s of g.series) if (!entry.series.includes(s)) entry.series.push(s)
    for (const h of g.handles) if (!entry.models.includes(h)) entry.models.push(h)
    // 대표 썸네일·링크는 표시 순서가 가장 앞선 행사 기준
    const ord = colOrder[g.collection_id] ?? Infinity
    if (ord < entry._ord) {
      entry._ord = ord
      entry.thumb = stat.thumb
      entry.collection_id = g.collection_id
      entry.group_id = g.id
    }
    byCharacter.set(g.character, entry)
  }
  const characters = [...byCharacter.values()]
  characters.forEach((ch) => {
    delete ch._ord
    ch.model_names = ch.models.map(displayName)
  })

  // 작품별 묶음 — 캐릭터가 여러 작품에 걸쳐 있으면 각 작품에 모두 들어갑니다.
  const seriesMap = new Map()
  for (const ch of characters) {
    for (const s of ch.series.length ? ch.series : ['']) {
      const bucket = seriesMap.get(s) || { name: s, characters: [], photo_count: 0, thumb: null, cover_set: false }
      bucket.characters.push(ch)
      bucket.photo_count += ch.photo_count
      if (seriesCover[s]) { bucket.thumb = seriesCover[s]; bucket.cover_set = true }
      else if (!bucket.cover_set && !bucket.thumb) bucket.thumb = ch.thumb
      seriesMap.set(s, bucket)
    }
  }
  const series = [...seriesMap.values()]
  series.forEach((s) => s.characters.sort((a, b) => b.photo_count - a.photo_count))
  series.sort((a, b) => b.photo_count - a.photo_count || a.name.localeCompare(b.name))
  return c.json({
    character_count: characters.length,
    series_count: series.length,
    series,
  }, 200, apiCacheHeaders(includeDrafts))
})

// 캐릭터 상세: 행사별 섹션으로 사진 묶음 (모델 상세와 같은 형태)
app.get('/api/characters/:name', async (c) => {
  const raw = decodeURIComponent(c.req.param('name'))
  const includeDrafts = await isAdmin(c)
  const { groups, cols, names, aliases } = await loadModelBase(c.env.DB, includeDrafts)
  const displayName = modelNameResolver(groups, names, aliases)
  const mine = groups.filter((g) => g.character === raw)
  if (!mine.length) return c.json({ error: 'not found' }, 404)
  const ids = mine.map((g) => g.id)
  const { results: photos } = await c.env.DB.prepare(
    `SELECT * FROM photos WHERE deleted_at IS NULL AND group_id IN (${ids.map(() => '?').join(',')})
     ORDER BY (sort_order IS NULL), sort_order, taken_at, id`
  ).bind(...ids).all()
  for (const p of photos) p.exif = parseJsonObject(p.exif_json)
  const byGroup = {}
  for (const p of photos) (byGroup[p.group_id] ||= []).push(p)
  const sections = []
  for (const col of cols) {
    for (const g of mine.filter((x) => x.collection_id === col.id)) {
      if (!byGroup[g.id]) continue
      sections.push({
        collection_id: col.id,
        title: col.title,
        date: col.date,
        character: g.character,
        series: g.series,
        handles: g.handles,
        model_names: g.handles.map(displayName),
        photos: byGroup[g.id],
      })
    }
  }
  if (!sections.length) return c.json({ error: 'not found' }, 404)
  const allSeries = []
  for (const g of mine) for (const s of g.series) if (!allSeries.includes(s)) allSeries.push(s)
  return c.json({
    character: raw,
    series: allSeries,
    photo_count: photos.length,
    sections,
  }, 200, apiCacheHeaders(includeDrafts))
})

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
  // 컬렉션 API와 같은 형태로 맞춥니다. 파싱하지 않으면 라이트박스에서 EXIF가 표시되지 않습니다.
  for (const p of photos) p.exif = parseJsonObject(p.exif_json)
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
        series: g.series,
        handles: g.handles,
        photos: byGroup[g.id],
      })
    }
  }
  // 표시 이름은 사이트 전체 공통 규칙(등록 이름 → 단독 폴더명 → 합동 폴더명 → @핸들)
  const displayName = modelNameResolver(groups, names, aliases)
  const display = mine.find((g) => resolveAlias(aliases, (g.handles[0] || '').toLowerCase()) === canon)
  const handle = (display && display.handles.find((h) => resolveAlias(aliases, h.toLowerCase()) === canon)) || raw
  return c.json({
    handle,
    name: displayName(handle),
    photo_count: photos.length,
    sections,
  }, 200, apiCacheHeaders(includeDrafts))
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
    `SELECT p.key_thumb, p.key_large, p.key_medium, p.width, p.height, p.collection_id, p.group_id,
            p.taken_at, p.exif_json,
            col.title, col.shoot_type, col.meta_json AS col_meta,
            g.name AS group_name, g.meta_json AS g_meta
     FROM photos p
     JOIN collections col ON col.id = p.collection_id
     LEFT JOIN groups g ON g.id = p.group_id
     WHERE p.deleted_at IS NULL AND col.deleted_at IS NULL${includeDrafts ? '' : ' AND col.published = 1'}
     ORDER BY (col.sort_order IS NOT NULL), col.sort_order, col.date DESC, col.id ASC,
              (p.sort_order IS NULL), p.sort_order, p.taken_at, p.id
     LIMIT ? OFFSET ?`
  ).bind(limit, offset).all()
  // 총 개수는 첫 페이지에서만 셉니다. 페이지마다 COUNT(*)를 다시 돌리면 무한 스크롤을
  // 한 번 당길 때마다 사진 전체를 훑게 됩니다. (이후 페이지는 total: null)
  const totalRow = offset === 0
    ? await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM photos p JOIN collections col ON col.id = p.collection_id
         WHERE p.deleted_at IS NULL AND col.deleted_at IS NULL${includeDrafts ? '' : ' AND col.published = 1'}`
      ).first()
    : null
  const { results: modelNameRows } = await c.env.DB.prepare('SELECT handle, name FROM model_names').all()
  const modelNames = Object.fromEntries(modelNameRows.map((row) => [row.handle.toLowerCase(), row.name]))
  return c.json({
    total: totalRow ? totalRow.n : null,
    photos: results.map((r) => {
      const meta = parseJsonObject(r.g_meta)
      const collectionModel = r.shoot_type === 'session' && r.group_id == null
        ? sessionModelOf(parseJsonObject(r.col_meta))
        : null
      const handles = collectionModel ? collectionModel.twitter : listMetaValues(meta.twitter)
      const modelNamesForPhoto = collectionModel
        ? resolvedSessionModelNames(collectionModel, handles, modelNames)
        : handles.map((handle) => modelNames[handle.toLowerCase()] || (handles.length === 1 ? r.group_name : ''))
      const character = collectionModel?.character || meta.character || ''
      return {
        key_thumb: r.key_thumb,
        key_large: r.key_large,
        key_medium: r.key_medium || r.key_large,
        // 라이트박스가 다른 페이지와 같은 정보를 보여주도록 EXIF·촬영일도 함께 반환합니다.
        taken_at: r.taken_at,
        exif: parseJsonObject(r.exif_json),
        width: r.width,
        height: r.height,
        collection_id: r.collection_id,
        title: r.title,
        models: handles,
        model_names: modelNamesForPhoto,
        character,
        series: collectionModel ? seriesOf(collectionModel) : seriesOf(meta),
      }
    }),
  }, 200, apiCacheHeaders(includeDrafts))
})

// 홈 랜덤 슬라이드용: 전체 사진 + 행사명 + 모델 크레딧
// 메인 랜덤 슬라이드용 표본. 전체 카탈로그를 내려보내면 사진이 늘수록 홈 첫 화면이 무거워집니다.
const FEATURE_SAMPLE_SIZE = 40

app.get('/api/feature-photos', async (c) => {
  const includeDrafts = await isAdmin(c)
  const { results } = await c.env.DB.prepare(
    `SELECT p.key_large, p.key_medium, p.collection_id, p.group_id,
            col.title, col.shoot_type, col.meta_json AS col_meta,
            g.name AS group_name, g.meta_json AS g_meta
     FROM photos p
     JOIN collections col ON col.id = p.collection_id
     LEFT JOIN groups g ON g.id = p.group_id
     WHERE p.deleted_at IS NULL AND col.deleted_at IS NULL${includeDrafts ? '' : ' AND col.published = 1'}
     ORDER BY RANDOM() LIMIT ?`
  ).bind(FEATURE_SAMPLE_SIZE).all()
  const { results: modelNameRows } = await c.env.DB.prepare('SELECT handle, name FROM model_names').all()
  const modelNames = Object.fromEntries(modelNameRows.map((row) => [row.handle.toLowerCase(), row.name]))
  return c.json(results.map((r) => {
    const meta = parseJsonObject(r.g_meta)
    const collectionModel = r.shoot_type === 'session' && r.group_id == null
      ? sessionModelOf(parseJsonObject(r.col_meta))
      : null
    const handles = collectionModel ? collectionModel.twitter : listMetaValues(meta.twitter)
    const modelNamesForPhoto = collectionModel
      ? resolvedSessionModelNames(collectionModel, handles, modelNames)
      : handles.map((handle) => modelNames[handle.toLowerCase()] || (handles.length === 1 ? r.group_name : ''))
    return {
      key_large: r.key_large,
      key_medium: r.key_medium || r.key_large,
      collection_id: r.collection_id,
      group_id: r.group_id,
      title: r.title,
      shoot_type: r.shoot_type || 'event',
      models: handles,
      model_names: modelNamesForPhoto,
      character: collectionModel?.character || meta.character || '',
      series: collectionModel ? seriesOf(collectionModel) : seriesOf(meta),
    }
  }), 200, apiCacheHeaders(includeDrafts))
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
    home_section_order: HOME_SECTION_ORDERS.has(map.home_section_order) ? map.home_section_order : 'events_first',
  }, 200, apiCacheHeaders(false))
})

app.patch('/api/settings', requireAdmin, async (c) => {
  const body = await c.req.json()
  if ('home_section_order' in body && !HOME_SECTION_ORDERS.has(body.home_section_order)) {
    return c.json({ error: 'invalid home_section_order' }, 400)
  }
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
  if ('home_section_order' in body) {
    await put('home_section_order', body.home_section_order)
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
  const { results } = await c.env.DB.prepare('SELECT key_large, key_medium, key_thumb FROM photos ORDER BY id').all()
  const keys = photoObjectKeys(results)
  const manifest = { id, created_at: new Date().toISOString(), status: 'pending', completed: 0, objects: keys.map((key) => ({ key })) }
  await writeBackupManifest(c.env.BACKUPS, manifest)
  return c.json({ id, object_count: keys.length, completed: 0, done: keys.length === 0 })
})

app.post('/api/backups/:id/run', requireAdmin, async (c) => {
  const manifest = await readBackupManifest(c.env.BACKUPS, c.req.param('id'))
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
    await c.env.BACKUPS.put(entry.backup_key, source.body, { httpMetadata: source.httpMetadata, customMetadata: source.customMetadata })
    manifest.completed = index + 1
  }
  const done = manifest.completed >= manifest.objects.length
  if (done) {
    manifest.status = 'complete'
    manifest.completed_at = new Date().toISOString()
  }
  await writeBackupManifest(c.env.BACKUPS, manifest)
  if (done) await rotateBackups(c.env.BACKUPS)
  return c.json({ id: manifest.id, object_count: manifest.objects.length, completed: manifest.completed, done })
})

app.get('/api/backups', requireAdmin, async (c) => {
  const manifests = (await listAllObjects(c.env.BACKUPS, BACKUP_PREFIX))
    .filter((object) => object.key.endsWith('/manifest.json'))
    .sort((a, b) => b.key.localeCompare(a.key))
  const backups = []
  for (const object of manifests) {
    const stored = await c.env.BACKUPS.get(object.key)
    if (stored) backups.push(JSON.parse(await stored.text()))
  }
  return c.json(backups.map(({ id, created_at, status, completed = 0, objects }) => ({
    id, created_at, status, completed, object_count: objects.length,
  })))
})

app.post('/api/backups/:id/restore', requireAdmin, async (c) => {
  const manifest = await readBackupManifest(c.env.BACKUPS, c.req.param('id'))
  if (!manifest) return c.json({ error: 'backup not found' }, 404)
  if (manifest.status !== 'complete') return c.json({ error: 'backup is not complete' }, 409)
  const body = await c.req.json().catch(() => ({}))
  const offset = Math.max(0, Number.parseInt(body.offset || '0', 10) || 0)
  const entries = (manifest.objects || []).slice(offset, offset + BACKUP_BATCH_SIZE)
  let restored = 0
  for (const entry of entries) {
    if (!entry.backup_key) continue
    const source = await c.env.BACKUPS.get(entry.backup_key)
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
  if (!(await c.env.BACKUPS.head(`${BACKUP_PREFIX}${id}/manifest.json`))) return c.json({ error: 'backup not found' }, 404)
  await deleteBackup(c.env.BACKUPS, id)
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
// 사진 1행이 가진 모든 R2 키(large/medium/thumb). medium은 예전 사진엔 없습니다.
function photoObjectKeys(rows) {
  return [...new Set([].concat(rows).flatMap((p) => [p.key_large, p.key_medium, p.key_thumb]).filter(Boolean))]
}

app.delete('/api/trash/collections/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const col = await c.env.DB.prepare('SELECT id FROM collections WHERE id = ? AND deleted_at IS NOT NULL').bind(id).first()
  if (!col) return c.json({ error: 'not found in trash' }, 404)
  await c.env.DB.prepare('UPDATE collections SET purge_started_at = COALESCE(purge_started_at, ?) WHERE id = ?')
    .bind(new Date().toISOString(), id).run()
  const { results: photos } = await c.env.DB.prepare(
    'SELECT key_large, key_medium, key_thumb FROM photos WHERE collection_id = ?'
  ).bind(id).all()
  const keys = photoObjectKeys(photos)
  await deleteR2Keys(c.env.PHOTOS, keys)
  if (c.req.query('purge_backups') === '1') await removeKeysFromBackups(c.env.BACKUPS, keys)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM photos WHERE collection_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM groups WHERE collection_id = ?').bind(id),
    c.env.DB.prepare('UPDATE collections SET related_event_id = NULL WHERE related_event_id = ?').bind(id),
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
  const photoKeys = photoObjectKeys(photo)
  await deleteR2Keys(c.env.PHOTOS, photoKeys)
  if (c.req.query('purge_backups') === '1') {
    await removeKeysFromBackups(c.env.BACKUPS, photoKeys)
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
  // 새 폴더는 기존 최상단보다 앞선 순서를 받아 생성 직후 맨 위에 표시합니다.
  // 기존 폴더의 수동 순서는 건드리지 않고, 아직 순서가 없는 폴더도 뒤에서 계속 유지합니다.
  const { meta } = await c.env.DB.prepare(
    `INSERT INTO groups (collection_id, name, sort_order)
     SELECT ?, ?, COALESCE(MIN(sort_order) - 1, 0)
     FROM groups WHERE collection_id = ?`
  ).bind(collectionId, name, collectionId).run()
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
  // 작품(장르) — 쉼표 구분으로 여러 개. 오리지널 편입 캐릭터처럼 두 곳에 걸친 경우를 위해 배열입니다.
  if ('series' in body) {
    const list = (Array.isArray(body.series) ? body.series : String(body.series || '').split(','))
      .map((s) => normalizeSeries(String(s)))
      .filter(Boolean)
    const unique = [...new Set(list)]
    if (unique.length) meta.series = unique
    else delete meta.series
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
  let typeFields = null
  let existing = null
  if (['shoot_type', 'location_type', 'related_event_id', 'session_model'].some((field) => field in body)) {
    existing = await c.env.DB.prepare(
      'SELECT id, shoot_type, location_type, related_event_id, meta_json FROM collections WHERE id = ? AND deleted_at IS NULL'
    ).bind(id).first()
    if (!existing) return c.json({ error: 'not found' }, 404)
    typeFields = await collectionTypeFields(c.env.DB, body, existing, id)
    if (typeFields.error) return c.json({ error: typeFields.error }, 400)
  }
  const fields = ['title', 'date', 'description', 'cover_photo_id', 'published', 'shoot_type', 'location_type', 'related_event_id']
  const sets = [], vals = []
  for (const f of fields) {
    if (f in body) {
      if (f === 'published' && ![0, 1, false, true].includes(body[f])) return c.json({ error: 'published must be boolean' }, 400)
      sets.push(`${f} = ?`)
      vals.push(f === 'published' ? (body[f] ? 1 : 0) : typeFields && f === 'shoot_type' ? typeFields.shootType : typeFields && f === 'location_type' ? typeFields.locationType : typeFields && f === 'related_event_id' ? typeFields.relatedEventId : body[f])
    }
  }
  if ('session_model' in body) {
    const metadata = parseJsonObject(existing.meta_json)
    const sessionModel = (typeFields?.shootType || existing.shoot_type) === 'session'
      ? normalizeSessionModel(body.session_model)
      : null
    if (sessionModel) metadata.session_model = sessionModel
    else delete metadata.session_model
    sets.push('meta_json = ?')
    vals.push(JSON.stringify(metadata))
  }
  // 개인 세션에서 행사로 바꾸면서 relation을 생략한 경우에도 일관된 상태로 저장합니다.
  if (typeFields && body.shoot_type === 'event' && !('related_event_id' in body)) {
    sets.push('related_event_id = ?')
    vals.push(null)
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
export async function persistUpload({ bucket, keyLarge, keyThumb, keyMedium, large, thumb, medium, insertPhoto }) {
  const storedKeys = []
  try {
    await bucket.put(keyLarge, large.stream(), { httpMetadata: { contentType: large.type } })
    storedKeys.push(keyLarge)
    await bucket.put(keyThumb, thumb.stream(), { httpMetadata: { contentType: thumb.type } })
    storedKeys.push(keyThumb)
    if (medium && keyMedium) {
      await bucket.put(keyMedium, medium.stream(), { httpMetadata: { contentType: medium.type } })
      storedKeys.push(keyMedium)
    }
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
  // medium(1280px)은 카드·그리드용 변형입니다. 구버전 클라이언트 호환을 위해 선택 항목으로 둡니다.
  const mediumRaw = form.get('medium')
  const medium = mediumRaw && typeof mediumRaw !== 'string' ? mediumRaw : null
  if (!large || !thumb || typeof large === 'string' || typeof thumb === 'string') {
    return c.json({ error: 'large and thumb files required' }, 400)
  }
  const allowedTypes = new Set(['image/jpeg', 'image/webp'])
  if (!allowedTypes.has(large.type) || !allowedTypes.has(thumb.type) || (medium && !allowedTypes.has(medium.type))) {
    return c.json({ error: 'only JPEG and WebP images are allowed' }, 415)
  }
  if (large.size > 16 * 1024 * 1024 || thumb.size > 2 * 1024 * 1024 || (medium && medium.size > 8 * 1024 * 1024)) {
    return c.json({ error: 'image file is too large' }, 413)
  }
  const hasImageSignature = async (file) => {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    if (file.type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  }
  if (!(await hasImageSignature(large)) || !(await hasImageSignature(thumb)) || (medium && !(await hasImageSignature(medium)))) {
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
  const keyMedium = medium ? `p/${collectionId}/${uuid}-m.${medium.type === 'image/jpeg' ? 'jpg' : 'webp'}` : null
  const { meta } = await persistUpload({
    bucket: c.env.PHOTOS,
    keyLarge,
    keyThumb,
    keyMedium,
    large,
    thumb,
    medium,
    insertPhoto: () => c.env.DB.prepare(
      `INSERT INTO photos (collection_id, group_id, key_large, key_thumb, key_medium, width, height, taken_at, exif_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(collectionId, groupId, keyLarge, keyThumb, keyMedium, width, height, takenAt, exifJson).run(),
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
  return c.json({ id: meta.last_row_id, key_large: keyLarge, key_medium: keyMedium, key_thumb: keyThumb })
})

// medium 백필: 워커는 이미지를 리사이즈할 수 없으므로 관리자 브라우저가 large를 받아 축소해 되돌려 줍니다.
// 작품(series) 백필: 예전 폴더는 '작품 - 캐릭터' 한 줄만 갖고 있습니다.
// dry_run=1 이면 무엇이 어떻게 채워질지만 미리 보여주고 저장하지 않습니다.
app.post('/api/groups/backfill-series', requireAdmin, async (c) => {
  const dryRun = c.req.query('dry_run') === '1'
  const { results: groups } = await c.env.DB.prepare(
    'SELECT id, name, meta_json FROM groups ORDER BY id'
  ).all()
  const planned = []
  const statements = []
  for (const g of groups) {
    const meta = parseJsonObject(g.meta_json)
    if (Array.isArray(meta.series) && meta.series.length) continue // 이미 채워진 폴더는 건드리지 않습니다
    const { series } = splitCharacterLine(meta.character)
    if (!series) continue
    planned.push({ group_id: g.id, folder: g.name, character: meta.character || '', series: [series] })
    if (!dryRun) {
      statements.push(c.env.DB.prepare('UPDATE groups SET meta_json = ? WHERE id = ?')
        .bind(JSON.stringify({ ...meta, series: [series] }), g.id))
    }
  }
  if (statements.length) await c.env.DB.batch(statements)
  return c.json({ dry_run: dryRun, updated: dryRun ? 0 : planned.length, planned })
})

app.get('/api/photos/missing-medium', requireAdmin, async (c) => {
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50))
  const [{ results }, remainingRow] = await c.env.DB.batch([
    c.env.DB.prepare(
      'SELECT id, key_large FROM photos WHERE key_medium IS NULL AND deleted_at IS NULL ORDER BY id LIMIT ?'
    ).bind(limit),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE key_medium IS NULL AND deleted_at IS NULL'),
  ])
  return c.json({ photos: results, remaining: remainingRow.results?.[0]?.n || 0 })
})

app.post('/api/photos/:id/medium', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const photo = await c.env.DB.prepare('SELECT id, collection_id, key_medium FROM photos WHERE id = ? AND deleted_at IS NULL')
    .bind(id).first()
  if (!photo) return c.json({ error: 'not found' }, 404)
  if (photo.key_medium) return c.json({ ok: true, key_medium: photo.key_medium, skipped: true })

  const form = await c.req.formData()
  const medium = form.get('medium')
  if (!medium || typeof medium === 'string') return c.json({ error: 'medium file required' }, 400)
  if (!['image/jpeg', 'image/webp'].includes(medium.type)) {
    return c.json({ error: 'only JPEG and WebP images are allowed' }, 415)
  }
  if (medium.size > 8 * 1024 * 1024) return c.json({ error: 'image file is too large' }, 413)
  const bytes = new Uint8Array(await medium.slice(0, 12).arrayBuffer())
  const signatureOk = medium.type === 'image/jpeg'
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  if (!signatureOk) return c.json({ error: 'image content does not match its file type' }, 415)

  const keyMedium = `p/${photo.collection_id}/${crypto.randomUUID()}-m.${medium.type === 'image/jpeg' ? 'jpg' : 'webp'}`
  await c.env.PHOTOS.put(keyMedium, medium.stream(), { httpMetadata: { contentType: medium.type } })
  try {
    await c.env.DB.prepare('UPDATE photos SET key_medium = ? WHERE id = ? AND key_medium IS NULL').bind(keyMedium, id).run()
  } catch (error) {
    // DB 반영 실패 시 방금 올린 객체는 참조되지 않으므로 지웁니다.
    await c.env.PHOTOS.delete(keyMedium).catch(() => {})
    throw error
  }
  return c.json({ ok: true, key_medium: keyMedium })
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

// ---------- 일괄 작업 ----------
// 관리자에서 여러 장을 선택해 처리할 때 사진마다 요청을 보내면 왕복이 선택 수만큼 늘고,
// 중간에 실패하면 일부만 적용된 상태로 남습니다. 아래 두 엔드포인트는 D1 batch로 한 번에 끝냅니다.
const BULK_LIMIT = 500
function parseBulkIds(body) {
  if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.length > BULK_LIMIT) return null
  const ids = [...new Set(body.ids.map((id) => Number(id)))]
  return ids.every((id) => Number.isInteger(id) && id > 0) ? ids : null
}
// 대표 사진이 사라졌거나 비어 있으면 남은 사진 중 첫 장으로 다시 지정합니다.
function reassignCoverStatement(db, collectionId) {
  return db.prepare(
    `UPDATE collections SET cover_photo_id = (
       SELECT id FROM photos WHERE collection_id = ? AND deleted_at IS NULL
       ORDER BY (sort_order IS NULL), sort_order, taken_at, id LIMIT 1
     )
     WHERE id = ? AND (cover_photo_id IS NULL OR cover_photo_id NOT IN (
       SELECT id FROM photos WHERE collection_id = ? AND deleted_at IS NULL
     ))`
  ).bind(collectionId, collectionId, collectionId)
}

app.post('/api/photos/bulk-delete', requireAdmin, async (c) => {
  const ids = parseBulkIds(await c.req.json())
  if (!ids) return c.json({ error: `ids required (max ${BULK_LIMIT})` }, 400)
  const placeholders = ids.map(() => '?').join(',')
  const { results: photos } = await c.env.DB.prepare(
    `SELECT id, collection_id FROM photos WHERE id IN (${placeholders}) AND deleted_at IS NULL`
  ).bind(...ids).all()
  if (!photos.length) return c.json({ error: 'not found' }, 404)
  const foundIds = photos.map((p) => p.id)
  const collectionIds = [...new Set(photos.map((p) => p.collection_id))]
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE photos SET deleted_at = ? WHERE id IN (${foundIds.map(() => '?').join(',')})`
    ).bind(new Date().toISOString(), ...foundIds),
    ...collectionIds.map((collectionId) => reassignCoverStatement(c.env.DB, collectionId)),
  ])
  return c.json({ ok: true, deleted: foundIds.length, ids: foundIds })
})

app.post('/api/photos/bulk-move', requireAdmin, async (c) => {
  const body = await c.req.json()
  const ids = parseBulkIds(body)
  if (!ids) return c.json({ error: `ids required (max ${BULK_LIMIT})` }, 400)
  const groupId = body.group_id == null ? null : Number(body.group_id)
  if (groupId != null && !Number.isInteger(groupId)) return c.json({ error: 'invalid group_id' }, 400)

  const placeholders = ids.map(() => '?').join(',')
  const { results: photos } = await c.env.DB.prepare(
    `SELECT id, collection_id FROM photos WHERE id IN (${placeholders}) AND deleted_at IS NULL`
  ).bind(...ids).all()
  if (!photos.length) return c.json({ error: 'not found' }, 404)
  const collectionIds = [...new Set(photos.map((p) => p.collection_id))]
  // 이동 대상 폴더는 한 컬렉션에만 속하므로, 선택된 사진도 같은 컬렉션이어야 합니다.
  if (groupId != null) {
    if (collectionIds.length > 1) return c.json({ error: 'photos span multiple collections' }, 400)
    const group = await c.env.DB.prepare('SELECT id FROM groups WHERE id = ? AND collection_id = ?')
      .bind(groupId, collectionIds[0]).first()
    if (!group) return c.json({ error: 'group does not belong to collection' }, 400)
  }
  const foundIds = photos.map((p) => p.id)
  await c.env.DB.prepare(
    `UPDATE photos SET group_id = ? WHERE id IN (${foundIds.map(() => '?').join(',')})`
  ).bind(groupId, ...foundIds).run()
  return c.json({ ok: true, moved: foundIds.length, ids: foundIds })
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
  // 로그인한 관리자의 갤러리 확인과 집계 제외(nostat) 브라우저는 조회수에서 빼둡니다.
  // 통계 저장 실패가 갤러리 자체를 막지는 않도록 분리합니다.
  const optedOut = applyNostatPreference(c)
  if (isDirectPageVisit(c) && !optedOut && !(await isAdmin(c))) {
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

  // 배포마다 style.css·app.js 주소를 바꿉니다. 그러지 않으면 캐시가 옛 파일을 계속 쓰는데,
  // 특히 앱 내장 브라우저(트위터 등)에서 새 코드·서체가 반영되지 않아 확인이 어긋납니다.
  const build = (c.env.CF_VERSION_METADATA?.id || '').slice(0, 8)
  if (build) {
    html = html
      .replace('href="style.css"', `href="style.css?v=${build}"`)
      .replace('src="app.js"', `src="app.js?v=${build}"`)
      .replace('src="config.js"', `src="config.js?v=${build}"`)
  }
  // c.html로 반환해야 위에서 설정한 쿠키(nostat)가 응답에 함께 실립니다.
  return c.html(html)
})

// ---------- image serving (R2) ----------
// 업로드 키는 `p/{collectionId}/{uuid}-{l|m|t}.{ext}` 형식입니다. 접미사로 조회할 컬럼이 정해지므로
// 인덱스를 정확히 타는 등가 비교 한 번으로 끝납니다. (OR 조건은 photos 전체 스캔을 유발했습니다)
const KEY_COLUMN_BY_SUFFIX = { l: 'key_large', m: 'key_medium', t: 'key_thumb' }
function photoKeyColumn(key) {
  return KEY_COLUMN_BY_SUFFIX[/-([lmt])\.[a-z0-9]+$/i.exec(key)?.[1]?.toLowerCase()] || null
}
// 공개 이미지는 내용이 바뀌지 않습니다(키에 UUID 포함). 길게 캐시해 워커·D1 호출 자체를 줄입니다.
const PUBLIC_IMAGE_CACHE = 'public, max-age=2592000, stale-while-revalidate=86400'

app.get('/img/*', async (c) => {
  const key = c.req.path.slice('/img/'.length)
  const column = photoKeyColumn(key)
  const photo = await c.env.DB.prepare(
    column
      ? `SELECT p.deleted_at, col.published, col.deleted_at AS collection_deleted_at
         FROM photos p JOIN collections col ON col.id = p.collection_id
         WHERE p.${column} = ? LIMIT 1`
      // 접미사가 예상과 다른 예외적인 키만 넓게 조회합니다.
      : `SELECT p.deleted_at, col.published, col.deleted_at AS collection_deleted_at
         FROM photos p JOIN collections col ON col.id = p.collection_id
         WHERE p.key_large = ? OR p.key_medium = ? OR p.key_thumb = ? LIMIT 1`
  ).bind(...(column ? [key] : [key, key, key])).first()
  if (!photo) return c.text('not found', 404)
  const admin = await isAdmin(c)
  const isDraft = Boolean(photo.deleted_at || photo.collection_deleted_at) || photo.published !== 1
  if (!admin && isDraft) return c.text('not found', 404)

  // 초안·삭제 상태는 공개로 전환되기 전이라 캐시하지 않습니다.
  const cacheControl = admin || isDraft ? 'private, no-store' : PUBLIC_IMAGE_CACHE
  // 재검증 요청은 R2 조건부 조회로 본문 없이 304로 끊습니다.
  // (기존에는 If-None-Match를 무시하고 매번 이미지 전체를 다시 전송했습니다)
  // R2 onlyIf는 따옴표 없는 ETag를 받습니다. 헤더 값에서 weak 표시와 따옴표를 벗겨 전달합니다.
  const ifNoneMatch = c.req.header('if-none-match')?.split(',')[0]?.trim().replace(/^W\//, '').replace(/^"|"$/g, '')
  const obj = await c.env.PHOTOS.get(key, ifNoneMatch ? { onlyIf: { etagDoesNotMatch: ifNoneMatch } } : undefined)
  if (!obj) return c.text('not found', 404)
  if (!obj.body) {
    return new Response(null, { status: 304, headers: { ETag: obj.httpEtag, 'Cache-Control': cacheControl } })
  }
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/webp',
      'Cache-Control': cacheControl,
      ETag: obj.httpEtag,
      'Content-Length': String(obj.size),
    },
  })
})

// ---------- 정기 정리 (Cron) ----------
// 휴지통 보관 기간. 이 기간이 지난 항목은 자동으로 영구 삭제됩니다(R2 원본까지).
// 원본 스냅샷(_backups)은 건드리지 않으므로, 스냅샷이 있다면 그쪽에서 복구할 수 있습니다.
// (Workers 런타임은 모듈에서 함수가 아닌 값을 export하면 시작을 거부하므로 export하지 않습니다)
const TRASH_RETENTION_DAYS = 30
export function trashRetentionDays() { return TRASH_RETENTION_DAYS }

export async function runScheduledCleanup(env) {
  const now = Date.now()
  const cutoff = new Date(now - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const summary = { sessions: 0, loginAttempts: 0, photos: 0, collections: 0 }

  // 1) 만료 세션·오래된 로그인 시도 (그냥 두면 테이블이 계속 커집니다)
  const [sessions, attempts] = await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM login_attempts WHERE window_started_at <= ?').bind(now - LOGIN_WINDOW_MS),
  ])
  summary.sessions = sessions.meta?.changes || 0
  summary.loginAttempts = attempts.meta?.changes || 0

  // 2) 보관기한이 지난 휴지통 사진 (컬렉션째 지워질 사진은 아래 3)에서 함께 처리)
  const { results: stalePhotos } = await env.DB.prepare(
    `SELECT p.id, p.key_large, p.key_medium, p.key_thumb, p.collection_id FROM photos p
     JOIN collections col ON col.id = p.collection_id
     WHERE p.deleted_at IS NOT NULL AND p.deleted_at <= ? AND col.deleted_at IS NULL
     LIMIT 500`
  ).bind(cutoff).all()
  if (stalePhotos.length) {
    await deleteR2Keys(env.PHOTOS, photoObjectKeys(stalePhotos))
    const ids = stalePhotos.map((p) => p.id)
    const collectionIds = [...new Set(stalePhotos.map((p) => p.collection_id))]
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM photos WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids),
      ...collectionIds.map((collectionId) => reassignCoverStatement(env.DB, collectionId)),
    ])
    summary.photos = ids.length
  }

  // 3) 보관기한이 지난 휴지통 컬렉션 (사진·폴더까지 함께)
  const { results: staleCollections } = await env.DB.prepare(
    'SELECT id FROM collections WHERE deleted_at IS NOT NULL AND deleted_at <= ? LIMIT 20'
  ).bind(cutoff).all()
  for (const col of staleCollections) {
    const { results: photos } = await env.DB.prepare(
      'SELECT key_large, key_medium, key_thumb FROM photos WHERE collection_id = ?'
    ).bind(col.id).all()
    await deleteR2Keys(env.PHOTOS, photoObjectKeys(photos))
    await env.DB.batch([
      env.DB.prepare('DELETE FROM photos WHERE collection_id = ?').bind(col.id),
      env.DB.prepare('DELETE FROM groups WHERE collection_id = ?').bind(col.id),
      env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(col.id),
      env.DB.prepare("UPDATE settings SET value = '' WHERE key = 'featured_collection_id' AND value = ?").bind(String(col.id)),
    ])
    summary.collections++
  }

  console.log(JSON.stringify({ message: 'scheduled cleanup', retention_days: TRASH_RETENTION_DAYS, ...summary }))
  return summary
}

export default {
  fetch: app.fetch,
  scheduled: async (event, env, ctx) => {
    ctx.waitUntil(runScheduledCleanup(env).catch((error) => {
      console.error(JSON.stringify({ message: 'scheduled cleanup failed', error: String(error) }))
    }))
  },
}
