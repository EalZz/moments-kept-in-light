// ---------- 관리자 페이지: 로그인 → 컬렉션 관리 → 업로드 ----------
const app = document.getElementById('app')

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

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

// ---------- login ----------
async function boot() {
  const { admin } = await api('/me')
  if (admin) return renderCollections()
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
      renderCollections()
    } catch {
      document.getElementById('loginMsg').textContent = '비밀번호가 틀렸습니다'
    }
  }
  document.getElementById('loginBtn').addEventListener('click', tryLogin)
  document.getElementById('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin() })
}

// ---------- collections list ----------
async function renderCollections() {
  const [cols, stats] = await Promise.all([api('/collections'), api('/stats')])
  const daily = stats.daily || []
  const maxViews = Math.max(1, ...daily.map((d) => d.views))
  const firstDate = daily[0]?.view_date?.slice(5).replace('-', '.') || ''
  const lastDate = daily.at(-1)?.view_date?.slice(5).replace('-', '.') || ''
  app.innerHTML = `
    <div class="topbar">
      <h2>컬렉션 관리</h2>
      <div class="r">
        <button id="gridBtnMain">그리드 이미지</button>
        <button id="modelMgrBtn">모델 관리</button>
        <button id="aboutBtn">About 편집</button>
        <button onclick="location.href='/'">갤러리 보기</button>
        <button id="logoutBtn">로그아웃</button>
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
          ${daily.map((d) => `<div class="view-bar" style="height:${Math.max(3, Math.round(d.views / maxViews * 100))}%" title="${esc(d.view_date)} · ${Number(d.views).toLocaleString()}회"></div>`).join('')}
        </div>
        <div class="view-dates"><span>${esc(firstDate)}</span><span>${esc(lastDate)}</span></div>` : '<p class="muted">아직 집계된 조회수가 없습니다.</p>'}
    </div>
    <div class="panel">
      <h3>새 컬렉션</h3>
      <div class="row">
        <input id="newTitle" placeholder="제목 (예: 벚꽃 출사)" />
        <input id="newDate" placeholder="날짜 (예: 2026-05)" style="max-width:160px" />
      </div>
      <div class="row"><input id="newDesc" placeholder="설명 (선택)" /></div>
      <button class="primary" id="createBtn">만들기</button>
    </div>
    <div class="panel">
      <h3>컬렉션 ${cols.length}개</h3>
      <div id="colList">
        ${cols.map((c) => `
          <div class="col-item" data-id="${c.id}">
            ${c.cover_thumb ? `<img src="/img/${esc(c.cover_thumb)}" />` : '<div class="ph-placeholder"></div>'}
            <div class="t">
              <div class="title">${esc(c.title)}</div>
              <div class="info">${esc(c.date)}${c.date ? ' · ' : ''}${c.photo_count}장</div>
            </div>
            <div class="ord-btns">
              <button class="colUp" title="위로">▲</button>
              <button class="colDown" title="아래로">▼</button>
            </div>
          </div>`).join('') || '<p class="muted">아직 컬렉션이 없습니다. 위에서 만들어보세요.</p>'}
      </div>
    </div>`

  document.getElementById('gridBtnMain').addEventListener('click', openGridMaker)
  document.getElementById('modelMgrBtn').addEventListener('click', openModelManager)
  document.getElementById('aboutBtn').addEventListener('click', openAboutEditor)
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }); boot()
  })
  document.getElementById('createBtn').addEventListener('click', async () => {
    const title = document.getElementById('newTitle').value.trim()
    if (!title) return alert('제목을 입력하세요')
    const { id } = await api('/collections', {
      method: 'POST',
      json: {
        title,
        date: document.getElementById('newDate').value.trim(),
        description: document.getElementById('newDesc').value.trim(),
      },
    })
    renderCollection(id)
  })
  app.querySelectorAll('.col-item').forEach((el) =>
    el.addEventListener('click', () => renderCollection(el.dataset.id)))

  // 컬렉션 순서 이동 (▲▼) — 클릭이 컬렉션 열기로 번지지 않게 차단
  const moveCollection = async (cid, dir) => {
    const ids = cols.map((c) => c.id)
    const i = ids.indexOf(cid)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
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
}

// ---------- single collection: upload + manage ----------
// 섹션 = 컬렉션 바로 아래(groupId null) + 사람별 폴더들. 섹션마다 드롭존/트윗 가져오기/그리드.
function sectionHtml(col, group, photos) {
  const gid = group ? group.id : ''
  return `
    <div class="panel section" data-gid="${gid}">
      <div class="sec-head">
        <h3>${group ? '📁 ' + esc(group.name) : '행사 바로 아래'}
          <span class="muted">${photos.length}장${group && group.meta && group.meta.twitter ? ' · ' + [].concat(group.meta.twitter).map((h) => '@' + esc(h)).join(' ') : ''}${group && group.meta && group.meta.character ? ' · ' + esc(group.meta.character) : ''}</span>
        </h3>
        ${group ? `<div class="r">
          <button class="grpUp" title="폴더 위로">▲</button>
          <button class="grpDown" title="폴더 아래로">▼</button>
          <button class="renameGrp">이름 변경</button>
          <button class="setCredit">모델/캐릭터</button>
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
              <button class="delPh danger">삭제</button>
            </div>
          </div>`).join('')}
      </div>
    </div>`
}

async function renderCollection(id) {
  const [col, settings] = await Promise.all([api('/collections/' + id), api('/settings')])
  const groups = col.groups || []
  const ungrouped = col.photos.filter((p) => !p.group_id)
  const isFeatured = settings.featured_collection_id === col.id

  app.innerHTML = `
    <div class="topbar">
      <h2>${esc(col.title)} <span class="muted">${esc(col.date)}${isFeatured ? ' · 메인에 걸림' : ''}</span></h2>
      <div class="r">
        <button id="backBtn">← 목록</button>
        <button id="featureBtn">${isFeatured ? '메인 해제' : '메인에 걸기'}</button>
        <button id="newGrpBtn">+ 사람 폴더</button>
        <button id="gridBtn">그리드 이미지</button>
        <button class="danger" id="delColBtn">컬렉션 삭제</button>
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

  document.getElementById('backBtn').addEventListener('click', renderCollections)
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
    if (!confirm(`"${col.title}" 컬렉션과 사진 ${col.photos.length}장을 모두 삭제할까요?`)) return
    await api('/collections/' + id, { method: 'DELETE' })
    renderCollections()
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

    const renameBtn = sec.querySelector('.renameGrp')
    if (renameBtn) renameBtn.addEventListener('click', async () => {
      const g = groups.find((x) => x.id === gid)
      const name = prompt('새 이름', g ? g.name : '')
      if (!name || !name.trim()) return
      await api('/groups/' + gid, { method: 'PATCH', json: { name: name.trim() } })
      renderCollection(id)
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

    const creditBtn = sec.querySelector('.setCredit')
    if (creditBtn) creditBtn.addEventListener('click', async () => {
      const g = groups.find((x) => x.id === gid)
      const cur = [].concat((g && g.meta && g.meta.twitter) || []).join(', ')
      const handle = prompt('① 모델(코스어님) X 핸들 — @ 없이 입력, 여러 명이면 쉼표로 구분, 비우면 삭제\n예: aaa, bbb — 갤러리와 사진 뷰어에 링크로 표시됩니다.', cur)
      if (handle === null) return
      const curChr = (g && g.meta && g.meta.character) || ''
      const character = prompt('② 캐릭터명 — 모델 이름 밑에 작게 표시됩니다. 비우면 표시 안 함\n예: 붕괴: 스타레일 - 연희', curChr)
      if (character === null) return
      await api('/groups/' + gid, { method: 'PATCH', json: { twitter: handle.trim(), character: character.trim() } })
      renderCollection(id)
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
    b.addEventListener('click', async (e) => {
      const pid = e.target.closest('.admin-ph').dataset.id
      const choices = ['0. 행사 바로 아래', ...groups.map((g, i) => `${i + 1}. ${g.name}`)]
      const ans = prompt('어디로 옮길까요?\n' + choices.join('\n'), '0')
      if (ans === null) return
      const n = parseInt(ans, 10)
      if (isNaN(n) || n < 0 || n > groups.length) return alert('번호를 확인해주세요')
      await api('/photos/' + pid, { method: 'PATCH', json: { group_id: n === 0 ? null : groups[n - 1].id } })
      renderCollection(id)
    }))
  app.querySelectorAll('.delPh').forEach((b) =>
    b.addEventListener('click', async (e) => {
      const pid = e.target.closest('.admin-ph').dataset.id
      if (!confirm('이 사진을 삭제할까요?')) return
      await api('/photos/' + pid, { method: 'DELETE' })
      renderCollection(id)
    }))

  // ---------- 일괄 선택 (체크박스) → 선택 삭제/이동 ----------
  const sel = new Set()
  const bar = document.getElementById('bulkbar')
  const syncBar = () => {
    bar.hidden = sel.size === 0
    bar.querySelector('.bulk-count').textContent = `${sel.size}개 선택`
  }
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
    for (const pid of sel) await api('/photos/' + pid, { method: 'DELETE' })
    renderCollection(id)
  })
  document.getElementById('bulkMove').addEventListener('click', async () => {
    if (!sel.size) return
    const choices = ['0. 행사 바로 아래', ...groups.map((g, i) => `${i + 1}. ${g.name}`)]
    const ans = prompt(`선택한 ${sel.size}장을 어디로 옮길까요?\n` + choices.join('\n'), '0')
    if (ans === null) return
    const n = parseInt(ans, 10)
    if (isNaN(n) || n < 0 || n > groups.length) return alert('번호를 확인해주세요')
    const gid = n === 0 ? null : groups[n - 1].id
    for (const pid of sel) await api('/photos/' + pid, { method: 'PATCH', json: { group_id: gid } })
    renderCollection(id)
  })
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
  const thumb = await scaleTo(bmp, THUMB_MAX, 'image/webp', 0.8)
  bmp.close()
  return { large, thumb, exif, takenAt }
}

async function uploadOne(collectionId, groupId, file) {
  const { large, thumb, exif, takenAt } = await processFile(file)
  const form = new FormData()
  form.append('large', large.blob, 'l.webp')
  form.append('thumb', thumb.blob, 't.webp')
  form.append('width', large.w)
  form.append('height', large.h)
  form.append('taken_at', takenAt)
  form.append('exif', JSON.stringify(exif))
  if (groupId) form.append('group_id', groupId)
  await api(`/collections/${collectionId}/photos`, { method: 'POST', body: form })
}

async function uploadFiles(collectionId, groupId, files, status) {
  if (!files.length) return
  let done = 0, failed = 0
  for (const file of files) {
    status.textContent = `업로드 중… ${done + failed + 1} / ${files.length} (${file.name})`
    try {
      await uploadOne(collectionId, groupId, file)
      done++
    } catch (e) {
      console.error(file.name, e)
      failed++
    }
  }
  status.textContent = `완료: ${done}장 업로드${failed ? `, ${failed}장 실패` : ''}`
  renderCollection(collectionId)
}

boot()
