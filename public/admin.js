// ---------- 관리자 페이지: 로그인 → 컬렉션 관리 → 업로드 ----------
const app = document.getElementById('app')
let activeUploads = 0

window.addEventListener('beforeunload', (e) => {
  if (!activeUploads) return
  e.preventDefault()
  e.returnValue = ''
})

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

function collectionKindLabel(col) {
  return col?.shoot_type === 'session' ? '개인 세션' : '행사'
}
function collectionLocationLabel(value) {
  return ({ venue: '행사장', outdoor: '야외', studio: '스튜디오' }[value] || '')
}

async function api(path, opts = {}) {
  if (opts.json) {
    opts.body = JSON.stringify(opts.json)
    opts.headers = { 'Content-Type': 'application/json' }
    delete opts.json
  }
  const res = await fetch('/api' + path, opts)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status)
  return res.json()
}

let teardownAdminMenu = null // 이전 렌더의 document 리스너 해제 (페이지 이동 시 누적 방지)
function setupAdminMenu() {
  teardownAdminMenu?.()
  teardownAdminMenu = null
  const menu = document.querySelector('.admin-menu')
  if (!menu) return
  const toggle = menu.querySelector('.admin-menu-toggle')
  const popup = menu.querySelector('.admin-menu-popup')
  const close = () => { popup.hidden = true; toggle.setAttribute('aria-expanded', 'false') }
  toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    const open = popup.hidden
    popup.hidden = !open
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  popup.addEventListener('click', () => close())
  const onEscape = (event) => { if (event.key === 'Escape') close() }
  document.addEventListener('click', close)
  document.addEventListener('keydown', onEscape)
  teardownAdminMenu = () => {
    document.removeEventListener('click', close)
    document.removeEventListener('keydown', onEscape)
  }
}

async function downloadBackup() {
  const res = await fetch('/api/backup')
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status)
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `moments-backup-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// 예전 사진에는 medium(1280) 변형이 없습니다. large를 받아 브라우저에서 축소해 채웁니다.
async function backfillMediumVariants(onProgress) {
  let filled = 0
  for (;;) {
    const { photos, remaining } = await api('/photos/missing-medium?limit=50')
    if (!photos.length) return { filled, remaining: 0 }
    onProgress?.(filled, filled + remaining)
    for (const photo of photos) {
      const res = await fetch('/img/' + photo.key_large)
      if (!res.ok) throw new Error(`원본을 읽지 못했습니다 (사진 ${photo.id})`)
      const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'from-image' })
      const medium = await scaleTo(bmp, MEDIUM_MAX, 'image/webp', 0.82)
      bmp.close()
      const form = new FormData()
      form.append('medium', medium.blob, 'm.webp')
      await api(`/photos/${photo.id}/medium`, { method: 'POST', body: form })
      filled++
      onProgress?.(filled, filled + remaining)
    }
  }
}

async function createPhotoBackup() {
  let result = await api('/backups', { method: 'POST' })
  while (!result.done) result = await api(`/backups/${result.id}/run`, { method: 'POST' })
  return result
}

async function restorePhotoBackup() {
  const backups = await api('/backups')
  if (!backups.length) throw new Error('복원할 원본 스냅샷이 없습니다')
  const latest = backups.find((backup) => backup.status === 'complete')
  if (!latest) throw new Error('완료된 원본 스냅샷이 없습니다')
  if (!confirm(`${latest.created_at} 스냅샷의 사진 ${latest.object_count}개를 원래 위치로 복원할까요?`)) return null
  let offset = 0
  let total = 0
  while (true) {
    const result = await api(`/backups/${latest.id}/restore`, { method: 'POST', json: { offset } })
    total += result.restored
    if (result.done) return { restored: total }
    offset = result.next_offset
  }
}

async function deletePhotoBackup() {
  const backups = await api('/backups')
  if (!backups.length) throw new Error('삭제할 스냅샷이 없습니다')
  const choices = backups.map((backup, index) => `${index + 1}. ${backup.created_at} · ${backup.object_count}개 · ${backup.status}`).join('\n')
  const selected = Number(prompt(`삭제할 스냅샷 번호를 입력하세요.\n\n${choices}`))
  if (!Number.isInteger(selected) || selected < 1 || selected > backups.length) return null
  const target = backups[selected - 1]
  if (!confirm(`${target.created_at} 스냅샷을 삭제할까요?`)) return null
  return api(`/backups/${target.id}`, { method: 'DELETE' })
}

// ---------- 화면 이동 (해시 라우팅) ----------
// 관리자도 브라우저 뒤로가기로 목록으로 돌아갈 수 있어야 합니다.
// 화면을 직접 부르는 대신 해시만 바꾸고, 실제 렌더는 routeAdmin이 담당합니다.
let adminBooted = false
// 목록은 '#/'로 둡니다. 빈 해시로 두면 이미 빈 상태일 때 hashchange가 발생하지 않습니다.
function goCollections() {
  if ((location.hash || '') === '#/' || location.hash === '') routeAdmin()
  else location.hash = '#/'
}
function goCollection(id) { location.hash = '#/c/' + id }

async function routeAdmin() {
  if (!adminBooted) return
  const m = (location.hash || '').match(/^#\/c\/(\d+)$/)
  if (!m) return renderCollections()
  try {
    await renderCollection(m[1])
  } catch (error) {
    // 이미 삭제된 컬렉션 주소(뒤로/앞으로 이동·북마크)면 목록으로 되돌립니다.
    console.error('collection render failed', error)
    goCollections()
  }
}
window.addEventListener('hashchange', () => { routeAdmin() })

// ---------- login ----------
async function boot() {
  const { admin } = await api('/me')
  if (admin) { adminBooted = true; return routeAdmin() }
  app.innerHTML = `
    <div class="login-box panel">
      <h3>관리자 로그인</h3>
      <div class="row"><input type="password" id="pw" placeholder="비밀번호" autofocus /></div>
      <button class="primary" id="loginBtn" style="width:100%">로그인</button>
      <p class="muted" id="loginMsg" style="margin-top:10px"></p>
    </div>`
  const tryLogin = async () => {
    try {
      await api('/login', { method: 'POST', json: { password: document.getElementById('pw').value } })
      adminBooted = true
      routeAdmin()
    } catch {
      document.getElementById('loginMsg').textContent = '비밀번호가 틀렸습니다'
    }
  }
  document.getElementById('loginBtn').addEventListener('click', tryLogin)
  document.getElementById('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin() })
}

// ---------- collections list ----------
async function renderCollections() {
  selectedPhotos.clear() // 목록으로 나가면 사진 선택은 유지하지 않습니다.
  selectionCollectionId = null
  const [allCols, stats, homeSettings] = await Promise.all([
    api('/collections'), api('/stats'), api('/settings'),
  ])
  const cols = allCols.filter((c) => !c.deleted_at)
  const eventCols = cols.filter((c) => c.shoot_type !== 'session')
  const sessionCols = cols.filter((c) => c.shoot_type === 'session')
  const selectedHomeOrder = homeSettings.home_section_order === 'sessions_first'
    ? 'sessions_first'
    : 'events_first'
  const relatedEventOptions = eventCols.map((c) =>
    `<option value="${c.id}">${esc(c.title)}${c.date ? ` · ${esc(c.date)}` : ''}</option>`).join('')
  const daily = stats.daily || []
  const maxViews = Math.max(1, ...daily.map((d) => d.views))
  const firstDate = daily[0]?.view_date?.slice(5).replace('-', '.') || ''
  const lastDate = daily.at(-1)?.view_date?.slice(5).replace('-', '.') || ''
  const collectionListPanel = (kind, list) => {
    const label = kind === 'session' ? '개인 세션' : '행사'
    return `
      <div class="panel collection-type-panel">
        <h3>${label} <span class="muted">${list.length}개</span></h3>
        <div class="collection-type-list" data-kind="${kind}">
          ${list.map((c) => `
            <div class="col-item" data-id="${c.id}">
              ${c.cover_thumb ? `<img src="/img/${esc(c.cover_thumb)}" />` : '<div class="ph-placeholder"></div>'}
              <div class="t">
                <div class="title">${esc(c.title)}</div>
                <div class="info">${collectionKindLabel(c)}${c.date ? ` · ${esc(c.date)}` : ''}${c.location_type ? ` · ${collectionLocationLabel(c.location_type)}` : ''} · ${c.photo_count}장 · ${c.published === 0 ? '비공개' : '공개'}</div>
              </div>
              <div class="ord-btns">
                <button class="colUp" title="위로">▲</button>
                <button class="colDown" title="아래로">▼</button>
              </div>
            </div>`).join('') || '<p class="muted">아직 등록된 컬렉션이 없습니다.</p>'}
        </div>
      </div>`
  }
  app.innerHTML = `
    <div class="topbar">
      <h2>컬렉션 관리</h2>
      <div class="r admin-menu">
        <button class="admin-menu-toggle" aria-expanded="false" aria-haspopup="menu">관리 메뉴 ⋯</button>
        <div class="admin-menu-popup" role="menu" hidden>
          <button id="backupBtn">메타데이터 백업</button>
          <button id="mediumBackfillBtn">중간 크기 채우기</button>
          <button id="seriesBackfillBtn">작품 자동 채우기</button>
          <button id="photoBackupBtn">사진 원본 백업</button>
          <button id="photoRestoreBtn">최근 원본 복원</button>
          <button id="photoBackupDeleteBtn">스냅샷 삭제</button>
          <button id="trashBtn">휴지통</button>
          <button id="gridBtnMain">그리드 이미지</button>
          <button id="modelMgrBtn">모델 관리</button>
          <button id="seriesMgrBtn">작품·검색어 관리</button>
          <button id="aboutBtn">About 편집</button>
          <button id="galleryBtn">갤러리 보기</button>
          <button id="logoutBtn">로그아웃</button>
        </div>
      </div>
    </div>
    <div class="panel">
      <h3>사이트 조회수 <span class="muted">KST 기준 · 최근 ${daily.length}일</span></h3>
      <div class="stats-grid">
        <div class="stat-card"><div class="label">총조회수</div><div class="value">${Number(stats.total_views).toLocaleString()}</div></div>
        <div class="stat-card"><div class="label">오늘 조회수</div><div class="value">${Number(stats.today_views).toLocaleString()}</div></div>
      </div>
      ${daily.length ? `
        <div class="view-chart" aria-label="최근 일별 조회수">
          ${daily.map((d) => {
            const label = `${d.view_date} · ${Number(d.views).toLocaleString()}회`
            return `<button type="button" class="view-bar" style="height:${Math.max(3, Math.round(d.views / maxViews * 100))}%" data-tooltip="${esc(label)}" aria-label="${esc(label)}"></button>`
          }).join('')}
        </div>
        <div class="view-dates"><span>${esc(firstDate)}</span><span>${esc(lastDate)}</span></div>` : '<p class="muted">아직 집계된 조회수가 없습니다.</p>'}
    </div>
    <div class="panel">
      <h3>새 컬렉션</h3>
      <div class="row">
        <input id="newTitle" placeholder="제목 (예: 벚꽃 출사)" />
        <input id="newDate" placeholder="날짜 (예: 2026-05)" style="max-width:160px" />
      </div>
      <div class="row">
        <select id="newShootType" aria-label="촬영 유형">
          <option value="event">행사</option>
          <option value="session">개인 세션</option>
        </select>
        <select id="newLocationType" aria-label="촬영 장소">
          <option value="">장소 유형 없음</option>
          <option value="venue">행사장</option>
          <option value="outdoor">야외</option>
          <option value="studio">스튜디오</option>
        </select>
      </div>
      <div class="row">
        <select id="newRelatedEvent" aria-label="관련 행사" disabled>
          <option value="">관련 행사 없음</option>
          ${relatedEventOptions}
        </select>
        <span class="field-hint">개인 세션이 행사 중 촬영이면 연결할 수 있습니다.</span>
      </div>
      <div class="row"><input id="newDesc" placeholder="설명 (선택)" /></div>
      <button class="primary" id="createBtn">만들기</button>
    </div>
    <div class="panel home-order-panel">
      <div class="sec-head">
        <div>
          <h3>홈 섹션 순서</h3>
          <div class="muted">방문자 홈에서 Events와 Personal Sessions가 표시되는 순서</div>
        </div>
        <div class="home-order-control">
          <select id="homeSectionOrder" aria-label="홈 섹션 순서">
            <option value="events_first" ${selectedHomeOrder === 'events_first' ? 'selected' : ''}>Events 먼저</option>
            <option value="sessions_first" ${selectedHomeOrder === 'sessions_first' ? 'selected' : ''}>Personal Sessions 먼저</option>
          </select>
          <button class="primary" id="homeSectionOrderSave">저장</button>
          <span class="home-order-status" id="homeOrderStatus" role="status"></span>
        </div>
      </div>
    </div>
    ${collectionListPanel('event', eventCols)}
    ${collectionListPanel('session', sessionCols)}`

  setupAdminMenu()
  const homeOrderSelect = document.getElementById('homeSectionOrder')
  const homeOrderSave = document.getElementById('homeSectionOrderSave')
  const homeOrderStatus = document.getElementById('homeOrderStatus')
  homeOrderSave.addEventListener('click', async () => {
    homeOrderSave.disabled = true
    homeOrderStatus.textContent = '저장 중…'
    try {
      await api('/settings', { method: 'PATCH', json: { home_section_order: homeOrderSelect.value } })
      homeOrderStatus.textContent = '저장됨'
    } catch (error) {
      homeOrderStatus.textContent = ''
      alert('홈 섹션 순서 저장 실패: ' + error.message)
    } finally {
      homeOrderSave.disabled = false
    }
  })
  document.getElementById('backupBtn').addEventListener('click', async () => {
    try { await downloadBackup() } catch (e) { alert('백업 다운로드 실패: ' + e.message) }
  })
  document.getElementById('seriesBackfillBtn').addEventListener('click', async () => {
    try {
      const preview = await api('/groups/backfill-series?dry_run=1', { method: 'POST' })
      if (!preview.planned.length) return alert('모든 폴더에 작품이 이미 지정되어 있습니다.')
      const sample = preview.planned.slice(0, 12)
        .map((p) => `· ${p.series.join(', ')}  ←  ${p.character || p.folder}`).join('\n')
      const more = preview.planned.length > sample.length ? `\n… 외 ${preview.planned.length - sample.length}개` : ''
      if (!confirm(`폴더 ${preview.planned.length}개의 작품을 캐릭터명에서 자동으로 채웁니다.\n\n${sample}${more}\n\n계속할까요?`)) return
      const result = await api('/groups/backfill-series', { method: 'POST' })
      alert(`폴더 ${result.updated}개에 작품을 채웠습니다.`)
      renderCollections()
    } catch (e) {
      alert('작품 자동 채우기 실패: ' + e.message)
    }
  })
  document.getElementById('mediumBackfillBtn').addEventListener('click', async (event) => {
    const button = event.currentTarget
    const { remaining } = await api('/photos/missing-medium?limit=1').catch(() => ({ remaining: 0 }))
    if (!remaining) return alert('모든 사진에 중간 크기가 이미 있습니다.')
    if (!confirm(`중간 크기가 없는 사진 ${remaining}장을 채웁니다. 브라우저에서 축소하므로 시간이 걸립니다. 계속할까요?`)) return
    button.disabled = true
    try {
      const result = await backfillMediumVariants((filled, total) => {
        button.textContent = `중간 크기 채우는 중… ${filled}/${total}`
      })
      alert(`중간 크기 ${result.filled}장을 채웠습니다.`)
      renderCollections()
    } catch (e) {
      alert('중간 크기 채우기 실패: ' + e.message)
    } finally {
      button.disabled = false
      button.textContent = '중간 크기 채우기'
    }
  })
  document.getElementById('photoBackupBtn').addEventListener('click', async () => {
    if (!confirm('현재 R2 사진 원본을 스냅샷으로 백업할까요? 사진 수에 따라 시간이 걸릴 수 있습니다.')) return
    const button = document.getElementById('photoBackupBtn')
    button.disabled = true
    try {
      const result = await createPhotoBackup()
      alert(`사진 원본 ${result.object_count}개를 백업했습니다.`)
    } catch (e) { alert('사진 원본 백업 실패: ' + e.message) }
    finally { button.disabled = false }
  })
  document.getElementById('photoRestoreBtn').addEventListener('click', async () => {
    const button = document.getElementById('photoRestoreBtn')
    button.disabled = true
    try {
      const result = await restorePhotoBackup()
      if (result) alert(`사진 원본 ${result.restored}개를 복원했습니다.`)
    } catch (e) { alert('사진 원본 복원 실패: ' + e.message) }
    finally { button.disabled = false }
  })
  document.getElementById('photoBackupDeleteBtn').addEventListener('click', async () => {
    try {
      const result = await deletePhotoBackup()
      if (result) alert('스냅샷을 삭제했습니다.')
    } catch (e) { alert('스냅샷 삭제 실패: ' + e.message) }
  })
  document.getElementById('trashBtn').addEventListener('click', openTrash)
  document.getElementById('gridBtnMain').addEventListener('click', openGridMaker)
  document.getElementById('modelMgrBtn').addEventListener('click', openModelManager)
  document.getElementById('seriesMgrBtn').addEventListener('click', openSeriesManager)
  document.getElementById('aboutBtn').addEventListener('click', openAboutEditor)
  document.getElementById('galleryBtn').addEventListener('click', () => { location.href = '/' })
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }); boot()
  })
  document.getElementById('createBtn').addEventListener('click', async () => {
    const title = document.getElementById('newTitle').value.trim()
    if (!title) return alert('제목을 입력하세요')
    const shootType = document.getElementById('newShootType').value
    const { id } = await api('/collections', {
      method: 'POST',
      json: {
        title,
        date: document.getElementById('newDate').value.trim(),
        description: document.getElementById('newDesc').value.trim(),
        shoot_type: shootType,
        location_type: document.getElementById('newLocationType').value,
        related_event_id: shootType === 'session' ? (document.getElementById('newRelatedEvent').value || null) : null,
      },
    })
    goCollection(id)
  })
  app.querySelectorAll('.col-item').forEach((el) =>
    el.addEventListener('click', () => goCollection(el.dataset.id)))

  // 컬렉션 순서 이동 (▲▼) — 클릭이 컬렉션 열기로 번지지 않게 차단
  const orderedByKind = {
    event: eventCols.slice(),
    session: sessionCols.slice(),
  }
  const moveCollection = async (cid, dir) => {
    const current = cols.find((c) => String(c.id) === String(cid))
    if (!current) return
    const kind = current.shoot_type === 'session' ? 'session' : 'event'
    const ordered = orderedByKind[kind]
    const i = ordered.findIndex((c) => String(c.id) === String(cid))
    const j = i + dir
    if (i < 0 || j < 0 || j >= ordered.length) return
    ;[ordered[i], ordered[j]] = [ordered[j], ordered[i]]
    const offsets = { event: 0, session: 0 }
    const ids = cols.map((c) => {
      const currentKind = c.shoot_type === 'session' ? 'session' : 'event'
      return orderedByKind[currentKind][offsets[currentKind]++].id
    })
    await api('/collection-order', { method: 'PUT', json: { ids } })
    renderCollections()
  }
  app.querySelectorAll('.colUp').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      moveCollection(+e.target.closest('.col-item').dataset.id, -1)
    }))
  app.querySelectorAll('.colDown').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      moveCollection(+e.target.closest('.col-item').dataset.id, 1)
    }))

  const newType = document.getElementById('newShootType')
  const relatedEvent = document.getElementById('newRelatedEvent')
  const syncNewRelation = () => {
    const enabled = newType.value === 'session'
    relatedEvent.disabled = !enabled
    if (!enabled) relatedEvent.value = ''
  }
  newType.addEventListener('change', syncNewRelation)
  syncNewRelation()
}

// ---------- trash ----------
async function openTrash() {
  const overlay = document.createElement('div')
  overlay.className = 'grid-maker'
  overlay.innerHTML = '<div class="inner"><div class="gm-top"><h3>휴지통</h3><button id="trashClose">닫기</button></div><div id="trashBody" class="panel"><p class="muted">불러오는 중…</p></div></div>'
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden'

  const close = () => { document.body.style.overflow = ''; overlay.remove() }
  overlay.querySelector('#trashClose').addEventListener('click', close)

  const load = async () => {
    const { collections = [], photos = [] } = await api('/trash')
    const body = overlay.querySelector('#trashBody')
    body.innerHTML = `
      <h3>삭제된 컬렉션 <span class="muted">${collections.length}개</span></h3>
      ${collections.map((c) => `
        <div class="trash-item" data-type="collections" data-id="${c.id}">
          <div class="t"><div class="title">${esc(c.title)}</div><div class="info">${esc(c.deleted_at || '')}</div></div>
          <button class="trashRestore">복구</button><button class="trashDelete danger">영구 삭제</button><button class="trashErase danger">백업까지 완전 삭제</button>
        </div>`).join('') || '<p class="muted">삭제된 컬렉션이 없습니다.</p>'}
      <h3 style="margin-top:28px">삭제된 사진 <span class="muted">${photos.length}장</span></h3>
      ${photos.map((p) => `
        <div class="trash-item" data-type="photos" data-id="${p.id}">
          ${p.key_thumb ? `<img src="/img/${esc(p.key_thumb)}" />` : ''}
          <div class="t"><div class="title">${esc(p.filename || p.collection_title || `사진 #${p.id}`)}</div><div class="info">${esc(p.deleted_at || '')}</div></div>
          <button class="trashRestore">복구</button><button class="trashDelete danger">영구 삭제</button><button class="trashErase danger">백업까지 완전 삭제</button>
        </div>`).join('') || '<p class="muted">삭제된 사진이 없습니다.</p>'}`

    body.querySelectorAll('.trashRestore').forEach((button) => button.addEventListener('click', async () => {
      const item = button.closest('.trash-item')
      await api(`/trash/${item.dataset.type}/${item.dataset.id}/restore`, { method: 'POST' })
      load()
    }))
    body.querySelectorAll('.trashDelete').forEach((button) => button.addEventListener('click', async () => {
      const item = button.closest('.trash-item')
      if (!confirm('영구 삭제하면 복구할 수 없습니다. 계속할까요?')) return
      await api(`/trash/${item.dataset.type}/${item.dataset.id}`, { method: 'DELETE' })
      load()
    }))
    body.querySelectorAll('.trashErase').forEach((button) => button.addEventListener('click', async () => {
      const item = button.closest('.trash-item')
      if (!confirm('운영 원본과 모든 스냅샷 사본을 삭제합니다. 어디에서도 복구할 수 없습니다. 계속할까요?')) return
      await api(`/trash/${item.dataset.type}/${item.dataset.id}?purge_backups=1`, { method: 'DELETE' })
      load()
    }))
  }

  try { await load() } catch (e) { overlay.querySelector('#trashBody').innerHTML = `<p class="muted">휴지통을 불러오지 못했습니다: ${esc(e.message)}</p>` }
}

// ---------- single collection: upload + manage ----------
// 섹션 = 컬렉션 바로 아래(groupId null) + 사람별 폴더들. 섹션마다 드롭존/트윗 가져오기/그리드.
function sectionHtml(col, group, photos) {
  const gid = group ? group.id : ''
  return `
    <div class="panel section" data-gid="${gid}">
      <div class="sec-head">
        <h3>${group ? '📁 ' + esc(group.name) : '행사 바로 아래'}
          <span class="muted"><span class="sec-count">${photos.length}장</span>${group && group.meta && group.meta.twitter ? ' · ' + [].concat(group.meta.twitter).map((h) => '@' + esc(h)).join(' ') : ''}${group && group.meta && group.meta.character ? ' · ' + esc(group.meta.character) : ''}</span>
        </h3>
        ${group ? `<div class="r">
          <button class="grpUp" title="폴더 위로">▲</button>
          <button class="grpDown" title="폴더 아래로">▼</button>
          <button class="editGrp">폴더 정보</button>
          <button class="delGrp danger">폴더 삭제</button>
        </div>` : ''}
      </div>
      <div class="dropzone">사진을 끌어다 놓거나 클릭해서 선택</div>
      <input type="file" class="fileInput" accept="image/*" multiple hidden />
      <div class="row" style="margin-top:10px">
        <input class="tweetUrl" placeholder="트윗 URL 붙여넣기 (예: https://x.com/…/status/…)" />
        <button class="tweetBtn" style="white-space:nowrap">트윗에서 가져오기</button>
      </div>
      <div class="upload-status"></div>
      <div class="admin-grid">
        ${photos.map((p) => `
          <div class="admin-ph" data-id="${p.id}">
            <img src="/img/${esc(p.key_thumb)}" loading="lazy" />
            <span class="selbox" title="선택"></span>
            ${col.cover_photo_id === p.id ? '<span class="badge">대표</span>' : ''}
            <div class="acts">
              <button class="setCover">대표</button>
              <button class="movePh">이동</button>
              <button class="splitPh" title="세로 2~4등분해서 JPG 저장">세로 분할</button>
              <button class="delPh danger">삭제</button>
            </div>
          </div>`).join('')}
      </div>
    </div>`
}

async function openCollectionEditor(col) {
  let allCols
  try {
    allCols = await api('/collections')
  } catch (error) {
    alert('컬렉션 목록을 읽지 못했습니다: ' + error.message)
    return
  }
  const eventOptions = allCols
    .filter((item) => !item.deleted_at && item.shoot_type !== 'session' && String(item.id) !== String(col.id))
    .map((item) => `<option value="${item.id}" ${String(item.id) === String(col.related_event_id) ? 'selected' : ''}>${esc(item.title)}${item.date ? ` · ${esc(item.date)}` : ''}</option>`)
    .join('')
  const overlay = document.createElement('div')
  overlay.className = 'grid-maker'
  overlay.innerHTML = `
    <div class="inner" style="max-width:680px">
      <div class="gm-top"><h3>컬렉션 정보 수정</h3><button id="editColClose">닫기</button></div>
      <div class="panel">
        <div class="row"><input id="editColTitle" value="${esc(col.title)}" placeholder="제목" /></div>
        <div class="row"><input id="editColDate" value="${esc(col.date || '')}" placeholder="날짜 (예: 2026-05)" /></div>
        <div class="row">
          <select id="editColType" aria-label="촬영 유형">
            <option value="event" ${col.shoot_type !== 'session' ? 'selected' : ''}>행사</option>
            <option value="session" ${col.shoot_type === 'session' ? 'selected' : ''}>개인 세션</option>
          </select>
          <select id="editColLocation" aria-label="촬영 장소">
            <option value="" ${!col.location_type ? 'selected' : ''}>장소 유형 없음</option>
            <option value="venue" ${col.location_type === 'venue' ? 'selected' : ''}>행사장</option>
            <option value="outdoor" ${col.location_type === 'outdoor' ? 'selected' : ''}>야외</option>
            <option value="studio" ${col.location_type === 'studio' ? 'selected' : ''}>스튜디오</option>
          </select>
        </div>
        <div class="row">
          <select id="editColRelated" aria-label="관련 행사">
            <option value="">관련 행사 없음</option>
            ${eventOptions}
          </select>
          <span class="field-hint">개인 세션이 행사 중 촬영이면 연결할 수 있습니다.</span>
        </div>
        <div class="row"><textarea id="editColDesc" placeholder="설명 (선택)">${esc(col.description || '')}</textarea></div>
        <button class="primary" id="editColSave">저장</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden'
  const close = () => { document.body.style.overflow = ''; overlay.remove() }
  overlay.querySelector('#editColClose').addEventListener('click', close)
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close() })
  const type = overlay.querySelector('#editColType')
  const related = overlay.querySelector('#editColRelated')
  const syncRelation = () => {
    const enabled = type.value === 'session'
    related.disabled = !enabled
    if (!enabled) related.value = ''
  }
  type.addEventListener('change', syncRelation)
  syncRelation()
  overlay.querySelector('#editColSave').addEventListener('click', async () => {
    const title = overlay.querySelector('#editColTitle').value.trim()
    if (!title) return alert('제목을 입력하세요')
    const button = overlay.querySelector('#editColSave')
    button.disabled = true
    try {
      await api(`/collections/${col.id}`, {
        method: 'PATCH',
        json: {
          title,
          date: overlay.querySelector('#editColDate').value.trim(),
          description: overlay.querySelector('#editColDesc').value.trim(),
          shoot_type: type.value,
          location_type: overlay.querySelector('#editColLocation').value,
          related_event_id: type.value === 'session' ? (related.value || null) : null,
        },
      })
      close()
      renderCollection(col.id)
    } catch (error) {
      alert('컬렉션 정보 저장 실패: ' + error.message)
      button.disabled = false
    }
  })
  overlay.querySelector('#editColTitle').focus()
}

function createAdminDialog(title, content) {
  const overlay = document.createElement('div')
  overlay.className = 'grid-maker admin-dialog'
  overlay.innerHTML = `
    <div class="inner">
      <div class="gm-top"><h3>${esc(title)}</h3><button type="button" class="dialogClose">닫기</button></div>
      <div class="panel">${content}</div>
    </div>`
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden'
  const close = () => {
    document.removeEventListener('keydown', onKey)
    document.body.style.overflow = ''
    overlay.remove()
  }
  const onKey = (event) => { if (event.key === 'Escape') close() }
  overlay.querySelector('.dialogClose').addEventListener('click', close)
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close() })
  document.addEventListener('keydown', onKey)
  return { overlay, close }
}

function openGroupEditor(group, onSaved) {
  const currentHandles = [].concat((group.meta && group.meta.twitter) || []).join(', ')
  const currentCharacter = (group.meta && group.meta.character) || ''
  // 직접 저장한 작품만 입력칸에 채웁니다. 유도값(group.series)을 채워두면 그대로 저장돼
  // 캐릭터명을 나중에 고쳐도 옛 값이 남습니다. 유도값은 placeholder로만 보여줍니다.
  const currentSeries = [].concat((group.meta && group.meta.series) || []).join(', ')
  const derivedSeries = [].concat(group.series || []).join(', ')
  const { overlay, close } = createAdminDialog('폴더 정보 편집', `
    <div class="form-field">
      <label for="groupName">폴더 이름</label>
      <input id="groupName" value="${esc(group.name)}" placeholder="예: 연희 KANZE님" />
    </div>
    <div class="form-field">
      <label for="creditHandles">모델 X 계정</label>
      <input id="creditHandles" value="${esc(currentHandles)}" placeholder="예: aaa, bbb" />
      <div class="field-hint">@ 없이 입력하고, 여러 명이면 쉼표로 구분합니다. 비우면 계정 연결이 삭제됩니다.</div>
    </div>
    <div class="form-field">
      <label for="creditCharacter">캐릭터명</label>
      <input id="creditCharacter" value="${esc(currentCharacter)}" placeholder="예: 붕괴: 스타레일 - 연희" />
      <div class="field-hint">비우면 갤러리에 캐릭터명이 표시되지 않습니다.</div>
    </div>
    <div class="form-field">
      <label for="creditSeries">작품 (장르)</label>
      <input id="creditSeries" value="${esc(currentSeries)}" placeholder="${esc(derivedSeries || '예: 붕괴: 스타레일')}" />
      <div class="field-hint">${derivedSeries && !currentSeries ? `비워두면 캐릭터명에서 <b>${esc(derivedSeries)}</b>로 자동 지정됩니다. ` : ''}여러 곳에 걸친 캐릭터는 쉼표로 구분해 둘 다 넣을 수 있습니다 (예: 보컬로이드, 카루네 시에).</div>
    </div>
    <div class="dialog-actions"><button type="button" class="dialogCancel">취소</button><button type="button" class="primary dialogSave">저장</button></div>`)
  overlay.querySelector('.dialogCancel').addEventListener('click', close)
  overlay.querySelector('.dialogSave').addEventListener('click', async () => {
    const button = overlay.querySelector('.dialogSave')
    const name = overlay.querySelector('#groupName').value.trim()
    if (!name) {
      overlay.querySelector('#groupName').focus()
      return
    }
    button.disabled = true
    try {
      await api('/groups/' + group.id, {
        method: 'PATCH',
        json: {
          name,
          twitter: overlay.querySelector('#creditHandles').value.trim(),
          character: overlay.querySelector('#creditCharacter').value.trim(),
          series: overlay.querySelector('#creditSeries').value.trim(),
        },
      })
      close()
      onSaved()
    } catch (error) {
      alert('폴더 정보 저장 실패: ' + error.message)
      button.disabled = false
    }
  })
  overlay.querySelector('#groupName').focus()
}

function openMoveDialog(title, groups, onMove) {
  const options = [{ id: '', name: '행사 바로 아래' }, ...groups.map((group) => ({ id: String(group.id), name: group.name }))]
  const { overlay, close } = createAdminDialog(title, `
    <div class="move-options">
      ${options.map((option, index) => `<label class="move-option"><input type="radio" name="moveTarget" value="${esc(option.id)}" ${index === 0 ? 'checked' : ''} /><span>${esc(option.name)}</span></label>`).join('')}
    </div>
    <div class="dialog-actions"><button type="button" class="dialogCancel">취소</button><button type="button" class="primary dialogMove">이동</button></div>`)
  overlay.querySelector('.dialogCancel').addEventListener('click', close)
  overlay.querySelector('.dialogMove').addEventListener('click', async () => {
    const button = overlay.querySelector('.dialogMove')
    const value = overlay.querySelector('input[name="moveTarget"]:checked').value
    button.disabled = true
    try {
      await onMove(value ? +value : null)
      close()
    } catch (error) {
      alert('사진 이동 실패: ' + error.message)
      button.disabled = false
    }
  })
  overlay.querySelector('input[name="moveTarget"]').focus()
}

// 관리자 액션은 대부분 컬렉션 화면을 다시 그립니다. 그때 스크롤 위치와 선택 상태를 잃으면
// 사진 여러 장을 정리할 때마다 맨 위로 튀어 작업이 끊깁니다.
// 선택 집합은 렌더를 넘어 살아남아야 하므로 모듈 스코프에 두고, 컬렉션이 바뀔 때만 비웁니다.
const selectedPhotos = new Set()
let selectionCollectionId = null

async function renderCollection(id) {
  if (String(selectionCollectionId) !== String(id)) {
    selectedPhotos.clear()
    selectionCollectionId = id
  }
  // innerHTML 교체 전 위치를 기억해 렌더 후 그대로 되돌립니다.
  const keepScrollY = app.querySelector('.section') ? window.scrollY : 0
  const [col, settings] = await Promise.all([api('/collections/' + id), api('/settings')])
  const groups = col.groups || []
  const ungrouped = col.photos.filter((p) => !p.group_id)
  const isFeatured = settings.featured_collection_id === col.id

  app.innerHTML = `
    <div class="topbar">
      <h2><span class="kind-tag">${collectionKindLabel(col)}</span>${esc(col.title)} <span class="muted">${esc(col.date)}${isFeatured ? ' · 메인에 걸림' : ''}</span></h2>
      <div class="r">
        <button id="backBtn">← 목록</button>
        <div class="admin-menu">
          <button class="admin-menu-toggle" aria-expanded="false" aria-haspopup="menu">컬렉션 메뉴 ⋯</button>
          <div class="admin-menu-popup" role="menu" hidden>
            <button id="editColBtn">정보 수정</button>
            <button id="publishBtn">${col.published === 0 ? '공개하기' : '비공개로 전환'}</button>
            <button id="featureBtn">${isFeatured ? '메인 해제' : '메인에 걸기'}</button>
            <button id="newGrpBtn">+ 사람 폴더</button>
            <button id="gridBtn">그리드 이미지</button>
            <button class="danger" id="delColBtn">컬렉션 삭제</button>
          </div>
        </div>
      </div>
    </div>
    <div id="bulkbar" class="bulkbar" hidden>
      <span class="bulk-count">0개 선택</span>
      <div class="r">
        <button id="bulkMove">선택 이동</button>
        <button id="bulkDel" class="danger">선택 삭제</button>
        <button id="bulkClear">선택 해제</button>
      </div>
    </div>
    ${sectionHtml(col, null, ungrouped)}
    ${groups.map((g) => sectionHtml(col, g, col.photos.filter((p) => p.group_id === g.id))).join('')}`

  setupAdminMenu()
  document.getElementById('backBtn').addEventListener('click', goCollections)
  document.getElementById('editColBtn').addEventListener('click', () => openCollectionEditor(col))
  document.getElementById('publishBtn').addEventListener('click', async () => {
    const published = col.published === 0 ? 1 : 0
    await api('/collections/' + id, { method: 'PATCH', json: { published } })
    renderCollection(id)
  })
  document.getElementById('newGrpBtn').addEventListener('click', async () => {
    const name = prompt('폴더 이름 (예: 인물/캐릭터 이름)')
    if (!name || !name.trim()) return
    await api(`/collections/${id}/groups`, { method: 'POST', json: { name: name.trim() } })
    renderCollection(id)
  })
  document.getElementById('featureBtn').addEventListener('click', async () => {
    await api('/settings', { method: 'PATCH', json: { featured_collection_id: isFeatured ? null : col.id } })
    renderCollection(id)
  })
  document.getElementById('gridBtn').addEventListener('click', openGridMaker)
  document.getElementById('delColBtn').addEventListener('click', async () => {
    if (!confirm(`"${col.title}" 컬렉션과 사진 ${col.photos.length}장을 휴지통으로 옮길까요?`)) return
    await api('/collections/' + id, { method: 'DELETE' })
    goCollections()
  })

  // 섹션별 이벤트 연결
  app.querySelectorAll('.section').forEach((sec) => {
    const gid = sec.dataset.gid ? +sec.dataset.gid : null
    const dz = sec.querySelector('.dropzone')
    const fileInput = sec.querySelector('.fileInput')
    const status = sec.querySelector('.upload-status')

    dz.addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', () => uploadFiles(id, gid, [...fileInput.files], status))
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag') })
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'))
    dz.addEventListener('drop', (e) => {
      e.preventDefault()
      dz.classList.remove('drag')
      uploadFiles(id, gid, [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')), status)
    })

    sec.querySelector('.tweetBtn').addEventListener('click', () =>
      importTweet(id, gid, sec.querySelector('.tweetUrl').value.trim(), status))

    // 사진 드래그 정렬 (같은 섹션 안에서)
    let dragged = null
    sec.querySelectorAll('.admin-ph').forEach((ph) => {
      ph.draggable = true
      ph.addEventListener('dragstart', (e) => {
        dragged = ph
        ph.classList.add('dragging')
        e.dataTransfer.effectAllowed = 'move'
      })
      ph.addEventListener('dragover', (e) => {
        e.preventDefault()
        if (!dragged || dragged === ph || dragged.parentElement !== ph.parentElement) return
        const rect = ph.getBoundingClientRect()
        const before = e.clientX - rect.left < rect.width / 2
        ph.parentElement.insertBefore(dragged, before ? ph : ph.nextSibling)
      })
      ph.addEventListener('dragend', async () => {
        ph.classList.remove('dragging')
        if (!dragged) return
        dragged = null
        // 화면에 보이는 순서 그대로 저장 (섹션 표시 순 = 갤러리 순)
        const ids = [...document.querySelectorAll('.admin-ph')].map((el) => +el.dataset.id)
        await api(`/collections/${id}/photo-order`, { method: 'PUT', json: { ids } })
        status.textContent = '순서 저장됨'
      })
    })

    const delBtn = sec.querySelector('.delGrp')
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!confirm('폴더를 삭제할까요? 사진은 지워지지 않고 행사 바로 아래로 이동합니다.')) return
      await api('/groups/' + gid, { method: 'DELETE' })
      renderCollection(id)
    })
    // 폴더 순서 이동 (▲▼)
    const moveGroup = async (dir) => {
      const i = groups.findIndex((x) => x.id === gid)
      const j = i + dir
      if (i < 0 || j < 0 || j >= groups.length) return
      const ids = groups.map((x) => x.id)
      ;[ids[i], ids[j]] = [ids[j], ids[i]]
      await api(`/collections/${id}/group-order`, { method: 'PUT', json: { ids } })
      renderCollection(id)
    }
    const upBtn = sec.querySelector('.grpUp')
    if (upBtn) upBtn.addEventListener('click', () => moveGroup(-1))
    const downBtn = sec.querySelector('.grpDown')
    if (downBtn) downBtn.addEventListener('click', () => moveGroup(1))

    const editBtn = sec.querySelector('.editGrp')
    if (editBtn) editBtn.addEventListener('click', () => {
      const g = groups.find((x) => x.id === gid)
      openGroupEditor(g, () => renderCollection(id))
    })
  })

  // 사진별 액션
  app.querySelectorAll('.setCover').forEach((b) =>
    b.addEventListener('click', async (e) => {
      const pid = +e.target.closest('.admin-ph').dataset.id
      await api('/collections/' + id, { method: 'PATCH', json: { cover_photo_id: pid } })
      renderCollection(id)
    }))
  app.querySelectorAll('.movePh').forEach((b) =>
    b.addEventListener('click', (e) => {
      const pid = e.target.closest('.admin-ph').dataset.id
      openMoveDialog('사진 이동', groups, async (groupId) => {
        await api('/photos/' + pid, { method: 'PATCH', json: { group_id: groupId } })
        renderCollection(id)
      })
    }))
  app.querySelectorAll('.splitPh').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const pid = +e.target.closest('.admin-ph').dataset.id
      const photo = col.photos.find((p) => p.id === pid)
      if (photo) openVerticalSplitDialog(photo)
    }))
  app.querySelectorAll('.delPh').forEach((b) =>
    b.addEventListener('click', async (e) => {
      const pid = e.target.closest('.admin-ph').dataset.id
      if (!confirm('이 사진을 삭제할까요?')) return
      await api('/photos/' + pid, { method: 'DELETE' })
      renderCollection(id)
    }))

  // ---------- 일괄 선택 (체크박스) → 선택 삭제/이동 ----------
  const sel = selectedPhotos
  const bar = document.getElementById('bulkbar')
  const syncBar = () => {
    bar.hidden = sel.size === 0
    bar.querySelector('.bulk-count').textContent = `${sel.size}개 선택`
  }
  // 사진을 걷어낸 뒤 섹션 머리말의 장수 표시를 다시 계산합니다(재렌더 없이).
  const updateSectionCounts = () => {
    app.querySelectorAll('.section').forEach((section) => {
      const label = section.querySelector('.sec-count')
      if (label) label.textContent = `${section.querySelectorAll('.admin-ph').length}장`
    })
  }
  // 살아남은 선택 항목을 새로 그려진 카드에 다시 표시하고, 사라진 사진은 선택에서 뺍니다.
  for (const pid of [...sel]) {
    const ph = app.querySelector(`.admin-ph[data-id="${pid}"]`)
    if (ph) ph.classList.add('selected')
    else sel.delete(pid)
  }
  syncBar()
  if (keepScrollY) window.scrollTo(0, keepScrollY)
  app.querySelectorAll('.selbox').forEach((box) =>
    box.addEventListener('click', (e) => {
      e.stopPropagation()
      const ph = box.closest('.admin-ph')
      const pid = +ph.dataset.id
      if (sel.has(pid)) { sel.delete(pid); ph.classList.remove('selected') }
      else { sel.add(pid); ph.classList.add('selected') }
      syncBar()
    }))
  document.getElementById('bulkClear').addEventListener('click', () => {
    sel.clear(); app.querySelectorAll('.admin-ph.selected').forEach((el) => el.classList.remove('selected')); syncBar()
  })
  document.getElementById('bulkDel').addEventListener('click', async () => {
    if (!sel.size || !confirm(`선택한 ${sel.size}장을 삭제할까요?`)) return
    const ids = [...sel]
    try {
      const result = await api('/photos/bulk-delete', { method: 'POST', json: { ids } })
      // 재렌더 없이 해당 카드만 걷어내 스크롤 위치를 유지합니다.
      for (const pid of result.ids || ids) {
        app.querySelector(`.admin-ph[data-id="${pid}"]`)?.remove()
        sel.delete(pid)
      }
      syncBar()
      updateSectionCounts()
    } catch (e) {
      alert('일괄 삭제 실패: ' + e.message)
      renderCollection(id)
    }
  })
  document.getElementById('bulkMove').addEventListener('click', async () => {
    if (!sel.size) return
    openMoveDialog(`선택한 ${sel.size}장 이동`, groups, async (groupId) => {
      const ids = [...sel]
      try {
        await api('/photos/bulk-move', { method: 'POST', json: { ids, group_id: groupId } })
      } catch (e) {
        alert('일괄 이동 실패: ' + e.message)
      }
      // 이동은 섹션 구성이 바뀌므로 재렌더하되, 스크롤·선택은 renderCollection이 보존합니다.
      renderCollection(id)
    })
  })
}

// ---------- 작품·검색어 관리 ----------
// 작품 대표사진과, 사람들이 실제로 쓰는 검색어(서코·플엑 등)를 여기서 관리합니다.
const ALIAS_SECTIONS = [
  { kind: 'series', label: '작품', hint: '예: 승리의 여신: 니케 → 니케' },
  { kind: 'collection', label: '행사', hint: '이름이 같은 회차는 함께 적용됩니다 — 예: Comic World → 서코, 부코, 수코' },
  { kind: 'model', label: '모델', hint: '계정을 몰라도 부르는 이름으로 찾히게' },
]

async function openSeriesManager() {
  const [characters, aliases, collections, models] = await Promise.all([
    api('/characters'), api('/search-aliases'), api('/collections'), api('/models'),
  ])
  const aliasOf = (kind, target) => aliases
    .filter((a) => a.kind === kind && String(a.target) === String(target))
    .map((a) => a.alias)
  const byKorean = (a, b) => String(a).localeCompare(String(b), 'ko')
  // 행사 별칭은 '이름' 기준입니다. 같은 이름의 회차(날짜만 다른 것)를 한 줄로 묶어
  // 검색어를 한 번만 등록하면 모든 회차가 함께 찾히게 합니다.
  const collectionsByTitle = [...collections.reduce((map, col) => {
    const entry = map.get(col.title) || { title: col.title, dates: [], count: 0 }
    if (col.date) entry.dates.push(col.date)
    entry.count++
    return map.set(col.title, entry)
  }, new Map()).values()].sort((x, y) => byKorean(x.title, y.title))

  // 별칭 편집 줄 — 등록된 별칭은 지울 수 있는 칩으로, 아래 입력창으로 추가합니다.
  const aliasRow = (kind, target, title, sub) => `
    <div class="alias-item" data-kind="${esc(kind)}" data-target="${esc(String(target))}">
      <div class="t">
        <div class="title">${esc(title)}</div>
        ${sub ? `<div class="info">${esc(sub)}</div>` : ''}
        <div class="alias-chips">
          ${aliasOf(kind, target).map((a) =>
            `<button type="button" class="alias-chip" data-alias="${esc(a)}" title="클릭하면 삭제">${esc(a)} ×</button>`).join('')
            || '<span class="muted" style="font-size:11px">등록된 검색어 없음</span>'}
        </div>
      </div>
      <div class="alias-add">
        <input class="aliasInput" placeholder="검색어 추가 (쉼표로 여러 개)" />
        <button class="aliasAdd">추가</button>
      </div>
    </div>`

  const seriesRows = [...characters.series].sort((x, y) => byKorean(x.name, y.name)).map((sr) => `
    <div class="series-mgr-item">
      ${sr.thumb ? `<img src="/img/${esc(sr.thumb)}" />` : '<div class="ph-placeholder"></div>'}
      <div class="t" style="flex:1;min-width:0">
        <div class="title">${esc(sr.name || '작품 미지정')}${sr.cover_set ? ' <span class="muted" style="font-size:11px">대표 지정됨</span>' : ''}</div>
        <div class="info">캐릭터 ${sr.characters.length}명 · ${sr.photo_count}장</div>
      </div>
      <button class="pickCover" data-name="${esc(sr.name)}">대표사진</button>
    </div>
    ${aliasRow('series', sr.name, sr.name || '작품 미지정', '')}`).join('')

  const overlay = document.createElement('div')
  overlay.className = 'grid-maker'
  overlay.innerHTML = `
    <div class="inner">
      <div class="gm-top"><h3>작품 · 검색어 관리</h3><button id="smClose">닫기</button></div>
      <div class="panel">
        <h3>작품 <span class="muted">${characters.series_count}개 — 대표사진과 검색어를 지정합니다</span></h3>
        ${seriesRows || '<p class="muted">작품이 아직 없습니다.</p>'}
      </div>
      <div class="panel">
        <h3>행사 검색어 <span class="muted">${ALIAS_SECTIONS[1].hint}</span></h3>
        ${collectionsByTitle.map((col) => aliasRow(
            'collection', col.title, col.title,
            col.count > 1 ? `${col.count}회 · ${col.dates.sort().join(', ')}` : (col.dates[0] || '')
          )).join('') || '<p class="muted">행사가 아직 없습니다.</p>'}
      </div>
      <div class="panel">
        <h3>모델 검색어 <span class="muted">${ALIAS_SECTIONS[2].hint}</span></h3>
        ${[...models].sort((x, y) => byKorean(x.name, y.name))
            .map((m) => aliasRow('model', m.handle, m.name, '@' + m.handle)).join('')
          || '<p class="muted">모델이 아직 없습니다.</p>'}
      </div>
    </div>`
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden'
  const close = () => { document.body.style.overflow = ''; overlay.remove() }
  const refresh = () => { close(); openSeriesManager() }
  overlay.querySelector('#smClose').addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })

  // 검색어 추가
  overlay.querySelectorAll('.aliasAdd').forEach((btn) => btn.addEventListener('click', async () => {
    const item = btn.closest('.alias-item')
    const input = item.querySelector('.aliasInput')
    const alias = input.value.trim()
    if (!alias) return input.focus()
    btn.disabled = true
    try {
      await api('/search-aliases', { method: 'POST', json: { kind: item.dataset.kind, target: item.dataset.target, alias } })
      refresh()
    } catch (e) { alert('검색어 추가 실패: ' + e.message); btn.disabled = false }
  }))
  overlay.querySelectorAll('.aliasInput').forEach((input) =>
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.closest('.alias-item').querySelector('.aliasAdd').click() }))

  // 검색어 삭제 (칩 클릭)
  overlay.querySelectorAll('.alias-chip').forEach((chip) => chip.addEventListener('click', async () => {
    const item = chip.closest('.alias-item')
    const q = new URLSearchParams({ kind: item.dataset.kind, target: item.dataset.target, alias: chip.dataset.alias })
    try {
      await api('/search-aliases?' + q, { method: 'DELETE' })
      refresh()
    } catch (e) { alert('검색어 삭제 실패: ' + e.message) }
  }))

  // 대표사진 지정
  overlay.querySelectorAll('.pickCover').forEach((btn) =>
    btn.addEventListener('click', () => openSeriesCoverPicker(btn.dataset.name, refresh)))
}

async function openSeriesCoverPicker(name, onSaved) {
  const { photos, cover_photo_id } = await api('/series-photos?name=' + encodeURIComponent(name))
  const { overlay, close } = createAdminDialog(`대표사진 — ${name}`, `
    <p class="muted" style="margin-bottom:12px">사진을 누르면 이 작품의 대표사진이 됩니다.</p>
    <div class="gm-picker" style="max-height:420px">
      ${photos.map((p) => `
        <div class="pick${p.id === cover_photo_id ? ' on' : ''}" data-id="${p.id}">
          <img src="/img/${esc(p.key_thumb)}" />
        </div>`).join('') || '<p class="muted">사진이 없습니다.</p>'}
    </div>
    <div class="dialog-actions">
      <button type="button" class="clearCover">지정 해제</button>
      <button type="button" class="dialogCancel">닫기</button>
    </div>`)
  const save = async (photoId) => {
    try {
      await api('/series-cover', { method: 'PUT', json: { name, photo_id: photoId } })
      close()
      onSaved()
    } catch (e) { alert('대표사진 저장 실패: ' + e.message) }
  }
  overlay.querySelectorAll('.pick').forEach((el) => el.addEventListener('click', () => save(+el.dataset.id)))
  overlay.querySelector('.clearCover').addEventListener('click', () => save(null))
  overlay.querySelector('.dialogCancel').addEventListener('click', close)
}

// ---------- About 편집 ----------
async function openAboutEditor() {
  const s = await api('/settings')
  const a = s.about || (window.SITE && window.SITE.about) || {}
  const overlay = document.createElement('div')
  overlay.className = 'grid-maker'
  overlay.innerHTML = `
    <div class="inner" style="max-width:720px">
      <div class="gm-top">
        <h3>About 편집</h3>
        <div class="r" style="display:flex;gap:8px">
          <button class="primary" id="abSave">저장</button>
          <button id="abClose">닫기</button>
        </div>
      </div>
      <div class="panel">
        <h3>소개 문단 <span class="muted">빈 줄로 문단을 구분합니다 · 첫 문단은 메인 하단에도 표시</span></h3>
        <textarea id="abIntro" rows="6">${esc((a.intro || []).join('\n\n'))}</textarea>
      </div>
      <div class="panel">
        <h3>장비 <span class="muted">한 줄에 하나씩 · 비우면 섹션 숨김</span></h3>
        <textarea id="abGear" rows="4">${esc((a.gear || []).join('\n'))}</textarea>
      </div>
      <div class="panel">
        <h3>촬영 문의 안내 <span class="muted">한 줄 · 비우면 숨김</span></h3>
        <input id="abNote" value="${esc(a.note || '')}" />
      </div>
    </div>`
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden'
  const close = () => { document.body.style.overflow = ''; overlay.remove() }
  overlay.querySelector('#abClose').addEventListener('click', close)
  overlay.querySelector('#abSave').addEventListener('click', async () => {
    const about = {
      intro: overlay.querySelector('#abIntro').value.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean),
      gear: overlay.querySelector('#abGear').value.split('\n').map((t) => t.trim()).filter(Boolean),
      note: overlay.querySelector('#abNote').value.trim(),
    }
    await api('/settings', { method: 'PATCH', json: { about } })
    alert('저장됐습니다. 갤러리 About 페이지에 바로 반영돼요.')
    close()
  })
}

// ---------- 모델 관리 (이름/별칭) ----------
async function openModelManager() {
  const [models, aliases] = await Promise.all([api('/models'), api('/model-aliases')])
  const overlay = document.createElement('div')
  overlay.className = 'grid-maker' // 같은 오버레이 스타일 재사용
  overlay.innerHTML = `
    <div class="inner">
      <div class="gm-top">
        <h3>모델 관리</h3>
        <button id="mmClose">닫기</button>
      </div>
      <div class="panel">
        <h3>모델 목록 <span class="muted">${models.length}명 — 이름은 갤러리 Models 페이지에 표시됩니다</span></h3>
        ${models.map((m) => `
          <div class="col-item" data-handle="${esc(m.handle)}">
            ${m.cover_thumb ? `<img src="/img/${esc(m.cover_thumb)}" />` : '<div class="ph-placeholder"></div>'}
            <div class="t">
              <div class="title">${esc(m.name)}</div>
              <div class="info">@${esc(m.handle)} · ${m.photo_count}장 · 행사 ${m.collection_count}곳</div>
            </div>
            <button class="mmRename">이름 수정</button>
          </div>`).join('') || '<p class="muted">모델 계정이 등록된 폴더가 아직 없습니다.</p>'}
      </div>
      <div class="panel">
        <h3>핸들 별칭 <span class="muted">계정 아이디가 바뀌었을 때: 옛핸들 → 새핸들 연결</span></h3>
        ${aliases.map((a) => `
          <div class="col-item" data-old="${esc(a.old_handle)}">
            <div class="t"><div class="title">@${esc(a.old_handle)} → @${esc(a.new_handle)}</div></div>
            <button class="mmDelAlias danger">삭제</button>
          </div>`).join('') || '<p class="muted">등록된 별칭이 없습니다.</p>'}
        <div class="row" style="margin-top:12px">
          <input id="mmOld" placeholder="옛 핸들 (@ 없이)" />
          <input id="mmNew" placeholder="새 핸들 (@ 없이)" />
          <button class="primary" id="mmAddAlias" style="white-space:nowrap">연결</button>
        </div>
      </div>
    </div>`
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden'

  const close = () => { document.body.style.overflow = ''; overlay.remove() }
  const refresh = () => { close(); openModelManager() }
  overlay.querySelector('#mmClose').addEventListener('click', close)
  overlay.querySelectorAll('.mmRename').forEach((b) =>
    b.addEventListener('click', async (e) => {
      const item = e.target.closest('.col-item')
      const handle = item.dataset.handle
      const cur = item.querySelector('.title').textContent
      const name = prompt(`@${handle} 의 표시 이름 (비우면 자동 이름으로 복귀)`, cur)
      if (name === null) return
      await api('/model-names', { method: 'PUT', json: { handle, name: name.trim() } })
      refresh()
    }))
  overlay.querySelectorAll('.mmDelAlias').forEach((b) =>
    b.addEventListener('click', async (e) => {
      const old = e.target.closest('.col-item').dataset.old
      if (!confirm(`별칭 @${old} 연결을 삭제할까요?`)) return
      await api('/model-aliases/' + encodeURIComponent(old), { method: 'DELETE' })
      refresh()
    }))
  overlay.querySelector('#mmAddAlias').addEventListener('click', async () => {
    const o = overlay.querySelector('#mmOld').value.trim()
    const n = overlay.querySelector('#mmNew').value.trim()
    if (!o || !n) return alert('두 핸들을 모두 입력하세요')
    await api('/model-aliases', { method: 'PUT', json: { old_handle: o, new_handle: n } })
    refresh()
  })
}

// ---------- 그리드 이미지 만들기 (트윗용 콜라주) ----------
// justified 레이아웃: 사진 비율대로 줄 높이가 달라지는 배치. 목표 비율에 가장 가까운 줄 수를 자동 선택.
function justifiedLayout(aspects, W, targetRatio, gap, forceK) {
  const total = aspects.reduce((a, b) => a + b, 0)
  let best = null
  const ks = forceK
    ? [Math.min(forceK, aspects.length)]
    : Array.from({ length: aspects.length }, (_, i) => i + 1)
  for (const k of ks) {
    // k줄로 탐욕 분할 — 줄마다 비율 합이 비슷하게
    const target = total / k
    const rows = []
    let cur = [], sum = 0
    for (let i = 0; i < aspects.length; i++) {
      cur.push(i)
      sum += aspects[i]
      const photosLeft = aspects.length - 1 - i
      const rowsLeft = k - rows.length - 1
      // 목표량이 차면 줄 닫기. 남은 사진 수 = 남은 줄 수면 강제로 닫아 정확히 k줄 보장
      if (rows.length < k - 1 && photosLeft >= rowsLeft && (sum >= target || photosLeft === rowsLeft)) {
        rows.push(cur); cur = []; sum = 0
      }
    }
    if (cur.length) rows.push(cur)
    if (rows.length !== k) continue

    let H = gap * (k - 1)
    const rowData = rows.map((r) => {
      const S = r.reduce((a, i) => a + aspects[i], 0)
      const h = (W - gap * (r.length - 1)) / S
      H += h
      return { indices: r, h, h0: h } // h0 = 폭 계산용 원래 높이 (비율 보정 후에도 유지)
    })
    // 줄 높이를 f배 조정(셀은 cover라 크롭됨)해서 목표 비율에 접근.
    // 크롭은 0.62~1.6까지 허용하되 심할수록 감점, 줄마다 장수가 균등하면 가산점(3×3 같은 규칙적 배치 선호)
    const gapsTotal = gap * (k - 1)
    const targetH = W / targetRatio
    const f = Math.min(1.6, Math.max(0.62, (targetH - gapsTotal) / (H - gapsTotal)))
    const adjH = (H - gapsTotal) * f + gapsTotal
    const equalCounts = rows.every((r) => r.length === rows[0].length)
    const score = Math.abs(Math.log((W / adjH) / targetRatio)) // 목표 비율과의 차이
      + 0.15 * Math.abs(Math.log(f))                            // 크롭 정도 감점
      - (equalCounts && k > 1 ? 0.2 : 0)                        // 균등 배치 가산점
    if (!best || score < best.score) best = { rows: rowData, H: Math.round(adjH), f, score }
  }
  if (!best) return justifiedLayout(aspects, W, targetRatio, gap) // 강제 줄 수 실패 시 자동으로 폴백
  for (const r of best.rows) r.h *= best.f
  return best
}

function drawGrid(canvas, images, layout, W, gap, bg, offsetOf, widthMultOf, zoomOf) {
  canvas.width = W
  canvas.height = layout.H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, layout.H)
  const cells = [] // 드래그 편집용 셀 정보
  let y = 0
  for (const row of layout.rows) {
    const h = row.h
    // 폭 배분: 원본 비율 × 사용자가 조정한 배율(경계 드래그) → 줄 폭에 맞게 정규화
    const availW = W - gap * (row.indices.length - 1)
    const effs = row.indices.map((idx) =>
      (images[idx].naturalWidth / images[idx].naturalHeight) * (widthMultOf ? widthMultOf(idx) : 1))
    const S = effs.reduce((a, b) => a + b, 0)
    let x = 0
    row.indices.forEach((idx, j) => {
      const img = images[idx]
      const isLast = j === row.indices.length - 1
      const w = isLast ? W - x : availW * effs[j] / S // 마지막 사진은 반올림 오차 흡수
      // cover 방식으로 셀을 채움 — 크롭 위치는 드래그, 확대는 휠로 조정 가능
      const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight) * (zoomOf ? zoomOf(idx) : 1)
      const sw = w / scale, sh = h / scale
      const o = offsetOf ? offsetOf(idx) : { ox: 0.5, oy: 0.5 }
      ctx.drawImage(img,
        (img.naturalWidth - sw) * o.ox, (img.naturalHeight - sh) * o.oy, sw, sh,
        Math.round(x), Math.round(y), Math.round(w), Math.round(h))
      cells.push({ idx, x, y, w, h, sw, sh, img })
      x += w + gap
    })
    y += h + gap
  }
  return cells
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('JPG 생성에 실패했습니다'))
    }, type, quality)
  })
}

function splitDownloadName(photoId, index, count) {
  return `photo-${photoId}-split-${String(index + 1).padStart(2, '0')}of${String(count).padStart(2, '0')}.jpg`
}

function triggerBrowserDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function openVerticalSplitDialog(photo) {
  const sourceKey = photo.key_large || photo.key_medium || photo.key_thumb
  if (!sourceKey) return alert('분할할 원본을 찾을 수 없습니다')

  const { overlay, close } = createAdminDialog('세로 분할', `
    <div class="split-dialog-body">
      <div>
        <div class="split-source-frame">
          <img id="splitSource" alt="분할할 원본 사진" />
          <div class="split-guides" id="splitGuides"></div>
        </div>
        <div class="field-hint" id="splitSourceInfo">원본 불러오는 중…</div>
      </div>
      <div>
        <div class="split-controls">
          <label for="splitCount">세로 분할 수</label>
          <select id="splitCount">
            <option value="2">2등분</option>
            <option value="3">3등분</option>
            <option value="4">4등분</option>
          </select>
        </div>
        <div class="muted" id="splitInfo">분할 결과를 준비하는 중…</div>
        <div class="split-preview" id="splitPreview"></div>
        <div class="gm-hint">원본은 변경되지 않습니다. 결과는 왼쪽에서 오른쪽 순서로 개별 JPG로 저장됩니다.</div>
        <div class="split-status" id="splitStatus" role="status"></div>
      </div>
    </div>
    <div class="dialog-actions">
      <button type="button" class="dialogCancel">취소</button>
      <button type="button" class="primary" id="splitDownloadAll" disabled>전체 JPG 저장</button>
    </div>`)
  overlay.classList.add('split-dialog')

  const source = overlay.querySelector('#splitSource')
  const sourceInfo = overlay.querySelector('#splitSourceInfo')
  const splitCount = overlay.querySelector('#splitCount')
  const splitGuides = overlay.querySelector('#splitGuides')
  const splitInfo = overlay.querySelector('#splitInfo')
  const splitPreview = overlay.querySelector('#splitPreview')
  const splitStatus = overlay.querySelector('#splitStatus')
  const downloadAll = overlay.querySelector('#splitDownloadAll')
  let segments = []

  const saveSegment = async (segment, button) => {
    const originalText = button.textContent
    button.disabled = true
    button.textContent = '생성 중…'
    try {
      const blob = await canvasToBlob(segment.canvas, 'image/jpeg', 0.92)
      triggerBrowserDownload(blob, splitDownloadName(photo.id, segment.index, segment.count))
      splitStatus.textContent = `${segment.index + 1}/${segment.count} JPG 저장됨`
    } catch (error) {
      splitStatus.textContent = '저장 실패: ' + error.message
    } finally {
      button.disabled = false
      button.textContent = originalText
    }
  }

  const render = () => {
    if (!source.naturalWidth || !source.naturalHeight) return
    const count = Number(splitCount.value)
    const width = source.naturalWidth
    const height = source.naturalHeight
    segments = []
    splitPreview.innerHTML = ''
    splitGuides.innerHTML = Array.from({ length: count - 1 }, (_, i) =>
      `<span style="left:${((i + 1) / count) * 100}%"></span>`).join('')
    const widths = []

    for (let i = 0; i < count; i++) {
      const x0 = Math.floor(width * i / count)
      const x1 = Math.floor(width * (i + 1) / count)
      const partWidth = x1 - x0
      const canvas = document.createElement('canvas')
      canvas.width = partWidth
      canvas.height = height
      canvas.getContext('2d').drawImage(source, x0, 0, partWidth, height, 0, 0, partWidth, height)
      const segment = { canvas, index: i, count, width: partWidth, height }
      segments.push(segment)
      widths.push(partWidth)

      const piece = document.createElement('div')
      piece.className = 'split-piece'
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = `${i + 1}/${count} · ${partWidth}×${height}px`
      const saveButton = document.createElement('button')
      saveButton.type = 'button'
      saveButton.textContent = 'JPG 저장'
      saveButton.addEventListener('click', () => saveSegment(segment, saveButton))
      piece.append(canvas, label, saveButton)
      splitPreview.append(piece)
    }

    sourceInfo.textContent = `원본 ${width}×${height}px`
    splitInfo.textContent = `${count}장 · ${widths.join('px / ')}px × ${height}px`
    splitStatus.textContent = ''
    downloadAll.disabled = false
  }

  source.addEventListener('load', render)
  source.addEventListener('error', () => {
    sourceInfo.textContent = '원본을 불러오지 못했습니다.'
    splitInfo.textContent = '분할할 수 없습니다.'
    downloadAll.disabled = true
  })
  splitCount.addEventListener('change', render)
  overlay.querySelector('.dialogCancel').addEventListener('click', close)
  downloadAll.addEventListener('click', async () => {
    if (!segments.length) return
    downloadAll.disabled = true
    downloadAll.textContent = '저장 중…'
    try {
      for (const segment of segments) {
        const blob = await canvasToBlob(segment.canvas, 'image/jpeg', 0.92)
        triggerBrowserDownload(blob, splitDownloadName(photo.id, segment.index, segment.count))
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      splitStatus.textContent = `${segments.length}개 JPG 저장됨`
    } catch (error) {
      splitStatus.textContent = '저장 실패: ' + error.message
    } finally {
      downloadAll.disabled = false
      downloadAll.textContent = '전체 JPG 저장'
    }
  })
  source.src = '/img/' + sourceKey
}

// 전체 컬렉션/폴더의 사진을 모아 그리드 메이커 오픈
async function openGridMaker() {
  const cols = await api('/collections')
  const details = await Promise.all(cols.map((c) => api('/collections/' + c.id)))
  // 피커 섹션: 행사 → (바로 아래 사진) → 사람 폴더 순
  const sections = []
  for (const d of details) {
    const ungrouped = d.photos.filter((p) => !p.group_id)
    if (ungrouped.length) sections.push({ label: d.title, photos: ungrouped })
    for (const g of d.groups || []) {
      const ps = d.photos.filter((p) => p.group_id === g.id)
      if (ps.length) sections.push({ label: `${d.title} — ${g.name}`, photos: ps })
    }
  }
  const photos = sections.flatMap((s) => s.photos)
  const selected = [] // photo id 클릭 순서
  const overlay = document.createElement('div')
  overlay.className = 'grid-maker'
  overlay.innerHTML = `
    <div class="inner">
      <div class="gm-top">
        <h3>그리드 이미지 만들기</h3>
        <div class="r" style="display:flex;gap:8px">
          <button id="gmDownload" class="primary">JPG 다운로드</button>
          <button id="gmClose">닫기</button>
        </div>
      </div>
      <div class="gm-controls">
        <span>비율</span>
        <select id="gmRatio">
          <option value="1">1:1 (정방형)</option>
          <option value="1.7778">16:9 (가로)</option>
          <option value="1.3333">4:3</option>
          <option value="0.8">4:5 (세로)</option>
        </select>
        <span>여백</span>
        <select id="gmGap">
          <option value="0">없음</option>
          <option value="8" selected>보통</option>
          <option value="20">넓게</option>
        </select>
        <span>줄 수</span>
        <select id="gmRows">
          <option value="0">자동</option>
          <option value="1">1줄</option>
          <option value="2">2줄</option>
          <option value="3">3줄</option>
          <option value="4">4줄</option>
        </select>
        <span>배경</span>
        <select id="gmBg">
          <option value="#ffffff">흰색</option>
          <option value="#101012">검정</option>
        </select>
        <span class="muted" id="gmInfo">사진을 순서대로 클릭해서 선택하세요</span>
      </div>
      <div class="gm-picker">
        ${sections.map((s) => `
          <div class="gm-sec">${esc(s.label)}</div>
          ${s.photos.map((p) => `
            <div class="pick" data-id="${p.id}">
              <img src="/img/${esc(p.key_thumb)}" loading="lazy" />
              <span class="ord"></span>
            </div>`).join('')}`).join('')}
      </div>
      <div class="gm-preview"><canvas id="gmCanvas"></canvas>
        <div class="gm-hint">1:1 또는 16:9는 트위터 타임라인에서 잘리지 않습니다 · 선택한 순서대로 배치됩니다<br/>사진 드래그 = 잘리는 위치 · 경계 드래그 = 크기 배분 · 휠 = 사진 확대/축소 · 줄 수 = 배치 변경</div>
      </div>
    </div>`
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden'

  const canvas = overlay.querySelector('#gmCanvas')
  canvas.style.cursor = 'grab'
  const imgCache = {} // photo id → HTMLImageElement
  const offsets = {} // photo id → { ox, oy } 크롭 위치 (0~1, 기본 0.5 = 가운데)
  const widthMult = {} // photo id → 폭 배율 (경계 드래그로 조정, 기본 1)
  const zooms = {} // photo id → 셀 안 확대 배율 (휠로 조정, 1~3)
  let lastPicked = [], lastState = null
  const offsetOf = (idx) => {
    const pid = lastPicked[idx] && lastPicked[idx].id
    return offsets[pid] || { ox: 0.5, oy: 0.5 }
  }
  const widthMultOf = (idx) => {
    const pid = lastPicked[idx] && lastPicked[idx].id
    return widthMult[pid] || 1
  }
  const zoomOf = (idx) => {
    const pid = lastPicked[idx] && lastPicked[idx].id
    return zooms[pid] || 1
  }

  const loadImage = (p) => imgCache[p.id] || (imgCache[p.id] = new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = rej
    img.src = '/img/' + p.key_large
  }))

  let renderSeq = 0
  async function render() {
    // 선택 순서 뱃지 갱신
    overlay.querySelectorAll('.pick').forEach((el) => {
      const i = selected.indexOf(+el.dataset.id)
      el.classList.toggle('on', i >= 0)
      el.querySelector('.ord').textContent = i >= 0 ? i + 1 : ''
    })
    const info = overlay.querySelector('#gmInfo')
    if (selected.length < 2) {
      canvas.width = canvas.height = 0
      info.textContent = '사진을 순서대로 클릭해서 선택하세요 (2장 이상)'
      return
    }
    const seq = ++renderSeq
    info.textContent = `${selected.length}장 선택됨 · 미리보기 생성 중…`
    const picked = selected.map((pid) => photos.find((p) => p.id === pid))
    const images = await Promise.all(picked.map(loadImage))
    if (seq !== renderSeq) return // 그리는 동안 선택이 바뀌면 버림
    const W = 2048
    const gap = +overlay.querySelector('#gmGap').value * (W / 1000)
    const ratio = +overlay.querySelector('#gmRatio').value
    const forceK = +overlay.querySelector('#gmRows').value || 0
    const layout = justifiedLayout(images.map((im) => im.naturalWidth / im.naturalHeight), W, ratio, gap, forceK)
    lastPicked = picked
    const cells = drawGrid(canvas, images, layout, W, gap, overlay.querySelector('#gmBg').value, offsetOf, widthMultOf, zoomOf)
    lastState = { cells, images, layout, W, gap }
    info.textContent = `${selected.length}장 · ${W}×${layout.H}px`
  }

  // 미리보기 편집: 셀 안 드래그 = 크롭 위치, 셀 사이 경계 드래그 = 폭 배분
  const redraw = () => {
    if (!lastState) return
    lastState.cells = drawGrid(canvas, lastState.images, lastState.layout, lastState.W,
      lastState.gap, overlay.querySelector('#gmBg').value, offsetOf, widthMultOf, zoomOf)
  }
  let drag = null // { type: 'crop' | 'edge', ... }
  const canvasPoint = (e) => {
    const r = canvas.getBoundingClientRect()
    const s = canvas.width / r.width
    return { x: (e.clientX - r.left) * s, y: (e.clientY - r.top) * s, scale: s }
  }
  // 같은 줄의 인접한 두 셀 사이 경계 찾기 (±14px)
  const edgeAt = (pt) => {
    if (!lastState) return null
    const cells = lastState.cells
    for (let i = 0; i < cells.length - 1; i++) {
      const a = cells[i], b = cells[i + 1]
      if (Math.abs(a.y - b.y) > 1) continue // 다른 줄
      const edge = a.x + a.w + lastState.gap / 2
      if (Math.abs(pt.x - edge) < 14 && pt.y >= a.y && pt.y <= a.y + a.h) return { a, b }
    }
    return null
  }
  canvas.addEventListener('mousemove', (e) => {
    if (drag) return
    canvas.style.cursor = edgeAt(canvasPoint(e)) ? 'col-resize' : 'grab'
  })
  canvas.addEventListener('mousedown', (e) => {
    if (!lastState) return
    const pt = canvasPoint(e)
    const edge = edgeAt(pt)
    if (edge) {
      // 경계 드래그: 인접 두 칸의 폭을 주고받음 (다른 칸은 그대로)
      const { a, b } = edge
      drag = {
        type: 'edge', sx: pt.x,
        aPid: lastPicked[a.idx].id, bPid: lastPicked[b.idx].id,
        aIdx: a.idx, bIdx: b.idx,
        aW: a.w, bW: b.w,
      }
      canvas.style.cursor = 'col-resize'
      e.preventDefault()
      return
    }
    const cell = lastState.cells.find((c) =>
      pt.x >= c.x && pt.x <= c.x + c.w && pt.y >= c.y && pt.y <= c.y + c.h)
    if (!cell) return
    const pid = lastPicked[cell.idx].id
    drag = { type: 'crop', cell, pid, sx: pt.x, sy: pt.y, start: { ...(offsets[pid] || { ox: 0.5, oy: 0.5 }) } }
    canvas.style.cursor = 'grabbing'
    e.preventDefault()
  })
  const onDragMove = (e) => {
    if (!drag || !document.body.contains(canvas)) return
    const pt = canvasPoint(e)
    if (drag.type === 'edge') {
      const pairW = drag.aW + drag.bW
      const minW = Math.max(60, pairW * 0.12) // 너무 얇아지지 않게
      const newA = Math.min(pairW - minW, Math.max(minW, drag.aW + (pt.x - drag.sx)))
      const newB = pairW - newA
      // 배율 환산: 현재 폭 비율 유지한 채 두 칸만 재배분 (합이 같아 다른 칸 영향 없음)
      const aspA = lastState.images[drag.aIdx].naturalWidth / lastState.images[drag.aIdx].naturalHeight
      const aspB = lastState.images[drag.bIdx].naturalWidth / lastState.images[drag.bIdx].naturalHeight
      const eSum = aspA * (widthMult[drag.aPid] || 1) + aspB * (widthMult[drag.bPid] || 1)
      widthMult[drag.aPid] = (eSum * newA / pairW) / aspA
      widthMult[drag.bPid] = (eSum * newB / pairW) / aspB
      redraw()
      return
    }
    const { cell } = drag
    const drawScale = cell.h / cell.sh // 캔버스 px → 원본 px 변환
    const hidW = cell.img.naturalWidth - cell.sw
    const hidH = cell.img.naturalHeight - cell.sh
    const o = { ...drag.start }
    if (hidW > 1) o.ox = Math.min(1, Math.max(0, drag.start.ox - (pt.x - drag.sx) / drawScale / hidW))
    if (hidH > 1) o.oy = Math.min(1, Math.max(0, drag.start.oy - (pt.y - drag.sy) / drawScale / hidH))
    offsets[drag.pid] = o
    redraw()
  }
  const onDragEnd = () => {
    drag = null
    if (document.body.contains(canvas)) canvas.style.cursor = 'grab'
  }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)

  // 휠로 셀 안 사진 확대/축소 (1배 = 셀 꽉 채움, 최대 3배)
  canvas.addEventListener('wheel', (e) => {
    if (!lastState) return
    const pt = canvasPoint(e)
    const cell = lastState.cells.find((c) =>
      pt.x >= c.x && pt.x <= c.x + c.w && pt.y >= c.y && pt.y <= c.y + c.h)
    if (!cell) return
    e.preventDefault()
    const pid = lastPicked[cell.idx].id
    zooms[pid] = Math.min(3, Math.max(1, (zooms[pid] || 1) * Math.exp(-e.deltaY * 0.0015)))
    redraw()
  }, { passive: false })

  overlay.querySelectorAll('.pick').forEach((el) =>
    el.addEventListener('click', () => {
      const pid = +el.dataset.id
      const i = selected.indexOf(pid)
      if (i >= 0) selected.splice(i, 1)
      else selected.push(pid)
      render()
    }))
  overlay.querySelectorAll('select').forEach((s) => s.addEventListener('change', render))
  overlay.querySelector('#gmClose').addEventListener('click', () => {
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragEnd)
    document.body.style.overflow = ''
    overlay.remove()
  })
  overlay.querySelector('#gmDownload').addEventListener('click', () => {
    if (selected.length < 2) return alert('사진을 2장 이상 선택하세요')
    canvas.toBlob((blob) => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'photo_grid.jpg'
      a.click()
      URL.revokeObjectURL(a.href)
    }, 'image/jpeg', 0.92)
  })
}

// ---------- tweet import ----------
// 고정 템플릿 파싱: "{장르} - {캐릭터}" 줄과 "Model::{이름} 님 (@{계정})" 줄들
function parseTweetInfo(text) {
  const models = []
  const modelRe = /Model::\s*([^\n(]+?)\s*(?:님)?\s*\(\s*@?\s*([A-Za-z0-9_]+)\s*\)?/g
  let m
  while ((m = modelRe.exec(text))) models.push({ name: m[1].trim(), handle: m[2] })
  let character = ''
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('[') || t.startsWith('#') || /^Model::/i.test(t)) continue
    if (/\s[-–—]\s/.test(t)) { character = t; break }
  }
  return { models, character }
}

async function importTweet(collectionId, groupId, url, status) {
  if (!url) return alert('트윗 URL을 입력하세요')
  status.textContent = '트윗 정보 가져오는 중…'
  try {
    const { photos, text } = await api('/tweet-media?url=' + encodeURIComponent(url))

    // 템플릿에서 모델/캐릭터 정보 추출 → 확인 후 자동 등록
    const info = parseTweetInfo(text || '')
    // 이름-핸들 쌍을 모델 이름 사전에 자동 저장 (이미 등록된 이름은 유지)
    for (const mo of info.models) {
      api('/model-names', { method: 'PUT', json: { handle: mo.handle, name: mo.name + ' 님', auto: true } }).catch(() => {})
    }
    let targetGroup = groupId
    if (info.models.length || info.character) {
      const patch = {}
      if (info.models.length) patch.twitter = info.models.map((x) => x.handle).join(', ')
      if (info.character) patch.character = info.character
      const desc = [
        info.character ? '캐릭터: ' + info.character : '',
        ...info.models.map((x) => '모델: ' + x.name + ' 님 (@' + x.handle + ')'),
      ].filter(Boolean).join('\n')

      if (groupId) {
        if (confirm('트윗에서 정보를 찾았습니다:\n' + desc + '\n\n이 폴더의 모델 계정/캐릭터로 등록할까요?')) {
          await api('/groups/' + groupId, { method: 'PATCH', json: patch })
        }
      } else {
        if (confirm('트윗에서 정보를 찾았습니다:\n' + desc + '\n\n이 모델의 폴더를 만들어서 사진을 넣고 계정/캐릭터까지 등록할까요?\n(취소하면 행사 바로 아래에 사진만 올라갑니다)')) {
          const name = info.models.map((x) => x.name + ' 님').join(', ') || info.character
          const created = await api(`/collections/${collectionId}/groups`, { method: 'POST', json: { name } })
          await api('/groups/' + created.id, { method: 'PATCH', json: patch })
          targetGroup = created.id
        }
      }
    }
    let done = 0
    for (const p of photos) {
      status.textContent = `트윗 사진 다운로드/업로드 중… ${done + 1} / ${photos.length}`
      const res = await fetch('/api/fetch-image?url=' + encodeURIComponent(p.url))
      if (!res.ok) throw new Error('이미지 다운로드 실패')
      const blob = await res.blob()
      const file = new File([blob], 'tweet.jpg', { type: blob.type || 'image/jpeg' })
      await uploadOne(collectionId, targetGroup, file)
      done++
    }
    status.textContent = `완료: 트윗에서 ${done}장 가져옴`
    renderCollection(collectionId)
  } catch (e) {
    status.textContent = '실패: ' + e.message
  }
}

// ---------- client-side resize + EXIF ----------
const LARGE_MAX = 2048
const MEDIUM_MAX = 1280
const THUMB_MAX = 640

function scaleTo(bmp, max, type, quality) {
  const r = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * r))
  const h = Math.max(1, Math.round(bmp.height * r))
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h)
  return canvas.convertToBlob({ type, quality }).then((blob) => ({ blob, w, h }))
}

async function processFile(file) {
  const exif = await exifr.parse(file, {
    pick: ['Make', 'Model', 'LensModel', 'FNumber', 'ExposureTime', 'ISO', 'FocalLength', 'DateTimeOriginal'],
  }).catch(() => null) || {}
  const takenAt = exif.DateTimeOriginal instanceof Date && !isNaN(exif.DateTimeOriginal)
    ? exif.DateTimeOriginal.toISOString() : ''
  delete exif.DateTimeOriginal

  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const large = await scaleTo(bmp, LARGE_MAX, 'image/webp', 0.85)
  // 카드·그리드는 표시 폭이 작아 large(2048)를 쓰면 과대합니다. medium이 그 자리를 대신합니다.
  const medium = await scaleTo(bmp, MEDIUM_MAX, 'image/webp', 0.82)
  const thumb = await scaleTo(bmp, THUMB_MAX, 'image/webp', 0.8)
  bmp.close()
  return { large, medium, thumb, exif, takenAt }
}

async function uploadOne(collectionId, groupId, file) {
  const { large, medium, thumb, exif, takenAt } = await processFile(file)
  const form = new FormData()
  form.append('large', large.blob, 'l.webp')
  form.append('medium', medium.blob, 'm.webp')
  form.append('thumb', thumb.blob, 't.webp')
  form.append('width', large.w)
  form.append('height', large.h)
  form.append('taken_at', takenAt)
  form.append('exif', JSON.stringify(exif))
  if (groupId) form.append('group_id', groupId)
  await api(`/collections/${collectionId}/photos`, { method: 'POST', body: form })
}

// 동시 업로드 수. 브라우저 리사이즈(CPU)와 전송(네트워크)이 겹치도록 소수만 병렬로 돕니다.
const UPLOAD_CONCURRENCY = 3

async function uploadFiles(collectionId, groupId, files, status) {
  if (!files.length) return
  activeUploads++
  let done = 0
  let cancelled = false
  const failed = []
  const total = files.length
  status.innerHTML = `
    <div class="upload-progress"><div class="upload-progress-bar"></div></div>
    <div class="upload-progress-text"></div>
    <button type="button" class="cancelUploads">업로드 중단</button>`
  const bar = status.querySelector('.upload-progress-bar')
  const text = status.querySelector('.upload-progress-text')
  status.querySelector('.cancelUploads').addEventListener('click', () => {
    cancelled = true
    text.textContent = '남은 업로드를 중단합니다…'
  })
  const paint = () => {
    const finished = done + failed.length
    bar.style.width = `${Math.round((finished / total) * 100)}%`
    text.textContent = `업로드 중… ${finished} / ${total}${failed.length ? ` (실패 ${failed.length})` : ''}`
  }
  paint()

  try {
    // 공유 커서를 두고 워커 3개가 각자 다음 파일을 집어가는 방식 (순차 대비 체감 시간 크게 단축)
    let cursor = 0
    const worker = async () => {
      while (!cancelled) {
        const index = cursor++
        if (index >= files.length) return
        const file = files[index]
        try {
          await uploadOne(collectionId, groupId, file)
          done++
        } catch (e) {
          console.error(file.name, e)
          failed.push({ file, error: e.message || '업로드 실패' })
        }
        paint()
      }
    }
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker))
  } finally {
    activeUploads--
  }

  await renderCollection(collectionId)
  const sec = [...app.querySelectorAll('.section')].find((el) =>
    (el.dataset.gid ? +el.dataset.gid : null) === groupId)
  const nextStatus = sec && sec.querySelector('.upload-status')
  if (!nextStatus) return
  if (!failed.length) {
    nextStatus.textContent = cancelled ? `중단: ${done}장 업로드됨` : `완료: ${done}장 업로드`
    return
  }
  nextStatus.innerHTML = `
    <div>${cancelled ? '중단' : '완료'}: ${done}장 업로드, ${failed.length}장 실패</div>
    <ul class="upload-fail-list">${failed.map(({ file, error }) => `<li>${esc(file.name)} — ${esc(error)}</li>`).join('')}</ul>
    <button class="retryUploads">실패 항목 재시도</button>`
  nextStatus.querySelector('.retryUploads').addEventListener('click', () =>
    uploadFiles(collectionId, groupId, failed.map(({ file }) => file), nextStatus))
}

boot()
