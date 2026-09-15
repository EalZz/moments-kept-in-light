// ---------- 미니멀 갤러리 (해시 라우팅: #/ 홈, #/c/:id 컬렉션) ----------
const main = document.getElementById('main')

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

async function api(path) {
  const res = await fetch('/api' + path)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ---------- 이미지 페이드인: data-fade 이미지가 로드되면 부드럽게 표시 ----------
document.addEventListener('load', (e) => {
  const t = e.target
  if (t.tagName === 'IMG' && t.hasAttribute('data-fade')) t.classList.add('loaded')
}, true)
document.addEventListener('error', (e) => {
  const t = e.target
  if (t.tagName === 'IMG' && t.hasAttribute('data-fade')) t.classList.add('loaded') // 실패해도 갇히지 않게
}, true)
// 캐시된 이미지는 load 이벤트 전에 완료돼 있을 수 있음
function markLoadedImages() {
  document.querySelectorAll('img[data-fade]').forEach((im) => {
    if (im.complete && im.naturalWidth) im.classList.add('loaded')
  })
}

// ---------- 사이트 설정 반영 (config.js) ----------
const SITE = window.SITE || {}
document.title = SITE.name || 'PORTFOLIO'
document.querySelectorAll('[data-site-name]').forEach((el) => { el.textContent = SITE.name || 'PORTFOLIO' })
// 내비 링크: 홈의 해당 섹션으로 스크롤 (다른 페이지면 홈으로 이동 후 스크롤)
// 홈 렌더는 API 응답을 기다리므로 고정 시간 뒤에 스크롤하면 섹션이 아직 없어 최상단에 머물렀습니다.
// 그래서 목표를 pendingScroll에 적어두고, 라우터가 렌더를 끝낸 뒤 실제로 생길 때까지 기다려 내려갑니다.
let pendingScroll = null
function scrollToSectionWhenReady(target, { smooth = true, timeout = 6000 } = {}) {
  const start = performance.now()
  const offsetOf = (el) => Math.round(el.getBoundingClientRect().top + window.scrollY)
  let lastTop = null
  let steady = 0
  // 사용자가 직접 스크롤을 시작하면 아래 보정을 포기합니다(끌려가는 느낌을 주지 않게).
  let userMoved = false
  const markUser = () => { userMoved = true }
  const events = ['wheel', 'touchstart', 'keydown']
  events.forEach((type) => addEventListener(type, markUser, { once: true, passive: true }))
  const cleanup = () => events.forEach((type) => removeEventListener(type, markUser))

  // requestAnimationFrame이 아니라 타이머로 확인합니다.
  // 탭이 백그라운드면 rAF는 아예 호출되지 않아서 스크롤이 그냥 안 됩니다.
  const timer = setInterval(() => {
    const el = document.querySelector(target)
    const waited = performance.now() - start
    if (el) {
      const top = offsetOf(el)
      // 표지 배치(메이슨리)가 끝나기 전에 스크롤하면 문서 높이가 바뀌며 애니메이션이 취소됩니다.
      // 그래서 목표 위치가 몇 번 연속 같게 나온 뒤에 움직입니다.
      if (top === lastTop) steady++
      else { steady = 0; lastTop = top }
      if (steady >= 4 || waited > 2000) {
        clearInterval(timer)
        window.scrollTo(smooth ? { top, behavior: 'smooth' } : { top })
        // 그래도 중간에 끊기면(레이아웃이 더 밀리면) 한 번만 조용히 맞춰줍니다.
        setTimeout(() => {
          const now = document.querySelector(target)
          if (!userMoved && now && Math.abs(window.scrollY - offsetOf(now)) > 40) {
            window.scrollTo({ top: offsetOf(now) })
          }
          cleanup()
        }, smooth ? 1700 : 900) // 부드러운 스크롤이 끝날 시간을 준 뒤에 확인합니다
        return
      }
    }
    if (waited >= timeout) { clearInterval(timer); cleanup() }
  }, 50)
}
document.querySelectorAll('[data-scroll]').forEach((el) =>
  el.addEventListener('click', (ev) => {
    ev.preventDefault()
    const target = el.dataset.scroll
    if ((location.hash || '#/') !== '#/') {
      pendingScroll = target // 홈은 좌측 상단 워드마크로 가므로, 이 링크는 항상 섹션까지 데려갑니다
      location.hash = '#/'
    } else scrollToSectionWhenReady(target)  // 이미 홈이면 부드럽게 내려갑니다
  }))

// ---------- 인트로 (스크롤 패럴랙스) ----------
// 한 페이지 안에서 스크롤에 따라 요소가 서로 다른 속도로 움직이며 조립됨.
// 닉네임은 위로 빠르게 잘려 올라가고, 계정링크+아래 콘텐츠는 멘트보다 빠르게 따라 올라와 메인으로 합쳐짐.
// 스크롤을 올리면 역재생되며 다시 인트로. (자연 스크롤 → 모바일 안전, 스크롤 잠금/오버레이 없음)
const INTRO_TTL = 6 * 60 * 60 * 1000 // 6시간 내 재방문이면 인트로 없이 바로 메인 위치에서 시작
function introSeenRecently() {
  const t = +(localStorage.getItem('pht-intro-seen') || 0)
  return t && Date.now() - t < INTRO_TTL
}
function stampIntroSeen() { try { localStorage.setItem('pht-intro-seen', String(Date.now())) } catch {} }

// 인트로: 스크롤하면 히어로 위 여백이 스크롤보다 빠르게 줄어들어, 아래 콘텐츠(계정링크·슬라이드…)가
// 스크롤보다 빠르게 위로 쫓아 올라와 메인과 합쳐짐. 닉네임은 위로 잘려 사라짐. 문구는 하나(중복 없음).
// 제스처로 전환: 인트로(히어로 100vh 중앙) → 아래로 스크롤 의도 → 히어로가 접히며 아래 콘텐츠가 빠르게 올라와
// 스크롤 0의 "원래 메인"으로 착지(=인트로 없을 때와 100% 동일). 메인 최상단에서 위로 당기면 인트로 복귀.
let introActive = false
let introBusy = false // 전환 애니메이션 진행 중 (재트리거 방지)
// 인트로에서 헤드라인은 화면 중앙, 아래(슬라이드)는 화면 밖으로 가도록 두 shift 계산
function computeIntroY() {
  const hl = document.querySelector('.headline')
  const below = document.querySelector('.below-hero')
  if (!hl || !below) return
  const heroEl = document.querySelector('.hero')
  const pH = heroEl.style.transform, pB = below.style.transform
  heroEl.style.transform = 'none'; below.style.transform = 'none' // 원래(메인) 위치 측정
  const hlC = hl.getBoundingClientRect(); const bT = below.getBoundingClientRect().top
  heroEl.style.transform = pH; below.style.transform = pB
  const headlineCenter = hlC.top + hlC.height / 2
  const heroShift = Math.max(0, Math.round(innerHeight * 0.45 - headlineCenter)) // 헤드라인을 화면 살짝 위쪽에
  const belowShift = Math.max(heroShift, Math.round(innerHeight - bT + 24))    // 슬라이드 화면 밖
  document.documentElement.style.setProperty('--heroShift', heroShift + 'px')
  document.documentElement.style.setProperty('--belowShift', belowShift + 'px')
}
window.addEventListener('resize', () => { if (document.body.classList.contains('intro-on')) computeIntroY() }, { passive: true })
function atHome() { const h = location.hash; return h === '' || h === '#/' }
function showIntro() {
  if (!atHome()) return // 홈에서만 인트로 복귀(다른 페이지에선 위로 당겨도 인트로 안 나옴)
  if (introActive || introBusy) return
  introActive = true
  window.scrollTo(0, 0)
  computeIntroY()
  document.body.classList.add('intro-on', 'intro-go') // 접힌 상태에서 시작
  void document.body.offsetWidth                       // reflow
  document.body.classList.remove('intro-go')           // 펼쳐지는 애니메이션(→100vh)
  document.body.classList.add('intro-lock')
  // 세로 레일선을 서서히 사라지게(intro-on으로 opacity가 0이 된 상태에 1→0 페이드를 덧입힘)
  document.querySelectorAll('.frame .rail').forEach((el) => {
    if (el.animate) el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, easing: 'ease' })
  })
}
function dismissIntro() {
  if (!introActive) return
  introActive = false
  introBusy = true
  document.body.classList.add('intro-go')  // 접히는 애니메이션(→원래 메인)
  // 스크롤 잠금은 애니메이션 끝까지 유지 → 전환 중 들어온 휠/스와이프가 페이지를 밀지 못함
  stampIntroSeen()
  setTimeout(() => {
    document.body.classList.remove('intro-on', 'intro-go', 'intro-lock')
    window.scrollTo(0, 0) // 정확히 메인 최상단으로 보정
    introBusy = false
    // 세로 레일선을 서서히 등장(유저가 튀는 걸 못 느끼게). intro-on 해제로 opacity가 1이 된 상태에 0→1 페이드를 덧입힘.
    document.querySelectorAll('.frame .rail').forEach((el) => {
      if (el.animate) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1100, delay: 200, easing: 'ease', fill: 'backwards' })
    })
  }, 800)
}

// 인트로 상태: 아래로 스크롤 의도 → 메인으로
window.addEventListener('wheel', (e) => { if (introActive && e.deltaY > 0) dismissIntro() }, { passive: true })
window.addEventListener('keydown', (e) => {
  if (introActive && ['ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) dismissIntro()
})
let introTY = 0
window.addEventListener('touchstart', (e) => { introTY = e.touches[0].clientY }, { passive: true })
window.addEventListener('touchmove', (e) => { if (introActive && introTY - e.touches[0].clientY > 24) dismissIntro() }, { passive: true })
// 메인 최상단에서 위로 당기면 인트로 복귀
let introUpAcc = 0
window.addEventListener('wheel', (e) => {
  if (introActive) return
  if (scrollY <= 0 && e.deltaY < 0) { introUpAcc += -e.deltaY; if (introUpAcc > 140) { introUpAcc = 0; showIntro() } }
  else introUpAcc = 0
}, { passive: true })
// 모바일 복귀: 최상단에서 두 손가락으로 화면을 위로 밀면(손가락 아래로) 인트로.
// 두 손가락일 때만 preventDefault로 브라우저 pull-to-refresh 선점을 막음(한 손가락은 그대로 → 새로고침 정상).
let introPullY = null
window.addEventListener('touchstart', (e) => {
  introPullY = (atHome() && scrollY <= 0 && e.touches.length >= 2) ? (e.touches[0].clientY + e.touches[1].clientY) / 2 : null
}, { passive: true })
window.addEventListener('touchmove', (e) => {
  if (introActive || introPullY == null || e.touches.length < 2) return
  e.preventDefault() // 두 손가락 제스처 선점 (새로고침/오버스크롤 방지)
  const y = (e.touches[0].clientY + e.touches[1].clientY) / 2
  if (scrollY <= 0 && y - introPullY > 40) { introPullY = null; showIntro() }
}, { passive: false })

// 홈 렌더 시: 첫 방문이면 인트로부터, 재방문/기타는 원래 메인(위로 당기면 인트로)
function setupIntro(isHome) {
  document.body.classList.remove('intro-on', 'intro-go', 'intro-lock')
  introActive = false
  introBusy = false
  document.documentElement.style.removeProperty('--heroShift')
  document.documentElement.style.removeProperty('--belowShift')
  // 섹션으로 바로 내려가려는 이동이면 인트로를 띄우지 않습니다(intro-lock이 스크롤을 막습니다).
  if (isHome && document.querySelector('.hero') && !introSeenRecently() && !pendingScroll) {
    introActive = true
    window.scrollTo(0, 0)
    computeIntroY()
    document.body.classList.add('intro-on', 'intro-lock') // 펼쳐진 인트로
  }
}

// ---------- 통합 검색 ----------
// 색인을 한 번 받아 클라이언트에서 즉시 필터링합니다(입력마다 서버 왕복 없음).
// 결과는 작품 → 캐릭터 → 모델 → 행사 순으로 묶어 보여줍니다.
const searchPanel = document.getElementById('searchPanel')
const searchScrim = document.getElementById('searchScrim')
const searchInput = document.getElementById('searchInput')
const searchResults = document.getElementById('searchResults')
const searchToggle = document.querySelector('.search-toggle')
let searchIndex = null
let searchRows = []      // 표시 중인 결과(키보드 이동 대상)
let searchCursor = -1
let searchLoading = false

function highlight(text, query) {
  const value = String(text ?? '')
  if (!query) return esc(value)
  const at = value.toLowerCase().indexOf(query)
  if (at < 0) return esc(value)
  return esc(value.slice(0, at)) + '<mark>' + esc(value.slice(at, at + query.length)) + '</mark>' + esc(value.slice(at + query.length))
}

async function ensureSearchIndex() {
  if (searchIndex || searchLoading) return
  searchLoading = true
  try {
    searchIndex = await api('/search-index')
  } catch (e) {
    console.error('search index failed', e)
  } finally {
    searchLoading = false
  }
}

// 검색어에 맞는 항목을 그룹별로 모읍니다. 각 항목은 이동할 해시(href)를 갖습니다.
function searchMatches(query) {
  if (!searchIndex) return []
  const q = query.trim().toLowerCase()
  if (!q) return []
  // 별칭(서코·플엑 등)도 함께 봅니다. 배열이 들어오면 각 항목을 검사합니다.
  const has = (...fields) => fields.flat().some((f) => String(f ?? '').toLowerCase().includes(q))
  const groups = []

  const series = searchIndex.series.filter((s) => has(s.name, s.aliases || [])).slice(0, 6)
  if (series.length) {
    groups.push({ label: 'Series', items: series.map((s) => ({
      href: '#/photos', // 작품 전용 페이지가 생기면 여기를 바꿉니다
      thumb: s.thumb, circ: false,
      name: highlight(s.name, q),
      sub: `캐릭터 ${s.character_count}명`,
      count: `${s.photo_count}장`,
    })) })
  }

  const characters = searchIndex.characters
    .filter((ch) => has(ch.character, ch.series || []))
    .slice(0, 8)
  if (characters.length) {
    groups.push({ label: 'Characters', items: characters.map((ch) => ({
      href: '#/c/' + ch.collection_id + (ch.group_id ? '/g' + ch.group_id : ''),
      thumb: ch.thumb, circ: false,
      name: highlight(ch.character, q),
      sub: [(ch.series || []).join(', '), ch.collection_title].filter(Boolean).join(' · '),
      count: `${ch.photo_count}장`,
    })) })
  }

  const models = searchIndex.models.filter((m) => has(m.name, m.handle, m.aliases || [])).slice(0, 6)
  if (models.length) {
    groups.push({ label: 'Models', items: models.map((m) => ({
      href: '#/m/' + encodeURIComponent(m.handle),
      thumb: m.thumb, circ: true,
      name: highlight(m.name, q),
      sub: '@' + m.handle,
      count: `${m.photo_count}장`,
    })) })
  }

  const collections = searchIndex.collections.filter((c) => has(c.title, c.date, c.aliases || [])).slice(0, 6)
  if (collections.length) {
    groups.push({ label: 'Collections', items: collections.map((c) => ({
      href: '#/c/' + c.id,
      thumb: c.thumb, circ: false,
      name: highlight(c.title, q),
      sub: c.date || '',
      count: `${c.photo_count}장`,
    })) })
  }
  return groups
}

function renderSearchResults() {
  const query = searchInput.value
  if (!query.trim()) {
    searchResults.innerHTML = '<div class="search-empty">모델 이름·캐릭터·작품·행사명으로 찾아보세요.</div>'
    searchRows = []
    searchCursor = -1
    return
  }
  const groups = searchMatches(query)
  if (!groups.length) {
    searchResults.innerHTML = `<div class="search-empty">‘${esc(query.trim())}’에 맞는 결과가 없습니다.</div>`
    searchRows = []
    searchCursor = -1
    return
  }
  searchResults.innerHTML = groups.map((g) => `
    <div class="search-group">${esc(g.label)} · ${g.items.length}</div>
    ${g.items.map((it) => `
      <button type="button" class="search-row" role="option" data-href="${esc(it.href)}">
        ${it.thumb ? `<img class="th${it.circ ? ' circ' : ''}" src="/img/${esc(it.thumb)}" alt="" loading="lazy" />`
                   : `<span class="th${it.circ ? ' circ' : ''}"></span>`}
        <span class="t"><span class="n">${it.name}</span>${it.sub ? `<span class="s">${esc(it.sub)}</span>` : ''}</span>
        <span class="cnt">${esc(it.count)}</span>
      </button>`).join('')}`).join('')
  searchRows = [...searchResults.querySelectorAll('.search-row')]
  searchCursor = searchRows.length ? 0 : -1
  paintSearchCursor()
}

function paintSearchCursor() {
  searchRows.forEach((row, i) => {
    const on = i === searchCursor
    row.classList.toggle('on', on)
    row.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  if (searchCursor >= 0) searchRows[searchCursor].scrollIntoView({ block: 'nearest' })
}

function moveSearchCursor(step) {
  if (!searchRows.length) return
  searchCursor = (searchCursor + step + searchRows.length) % searchRows.length
  paintSearchCursor()
}

let searchPreviousFocus = null
function openSearch() {
  if (document.body.classList.contains('search-open')) return
  searchPreviousFocus = document.activeElement
  // 패널이 내비 바로 아래에서 시작하도록 실제 내비 높이를 알려줍니다.
  const navEl = document.querySelector('.nav')
  if (navEl) document.documentElement.style.setProperty('--nav-h', navEl.offsetHeight + 'px')
  document.body.classList.add('search-open')
  searchToggle?.setAttribute('aria-expanded', 'true')
  renderSearchResults()
  // 즉시 한 번, 전환이 시작된 뒤 한 번 더 — 환경에 따라 첫 시도가 무시될 수 있습니다.
  const focusField = () => { searchInput.focus(); searchInput.select() }
  focusField()
  requestAnimationFrame(focusField)
  ensureSearchIndex().then(() => { if (document.body.classList.contains('search-open')) renderSearchResults() })
}
function closeSearch() {
  if (!document.body.classList.contains('search-open')) return
  document.body.classList.remove('search-open')
  searchToggle?.setAttribute('aria-expanded', 'false')
  if (searchPreviousFocus && document.contains(searchPreviousFocus)) searchPreviousFocus.focus()
}

if (searchToggle) {
  searchToggle.addEventListener('click', () => {
    if (document.body.classList.contains('search-open')) closeSearch()
    else openSearch()
  })
  document.getElementById('searchClose').addEventListener('click', closeSearch)
  searchScrim.addEventListener('click', closeSearch)
  searchInput.addEventListener('input', renderSearchResults)
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSearchCursor(1) }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSearchCursor(-1) }
    else if (ev.key === 'Enter' && searchCursor >= 0) { ev.preventDefault(); searchRows[searchCursor].click() }
  })
  searchResults.addEventListener('click', (ev) => {
    const row = ev.target.closest('.search-row')
    if (!row) return
    closeSearch()
    location.hash = row.dataset.href
  })
  // 전역 단축키: '/' 로 열기, ESC 로 닫기 (입력 중일 때는 방해하지 않음)
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.body.classList.contains('search-open')) return closeSearch()
    if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) return
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    ev.preventDefault()
    openSearch()
  })
}

// 모바일 햄버거 메뉴 토글
const navToggle = document.querySelector('.nav-toggle')
const navLinks = document.querySelector('.nav-links')
if (navToggle) {
  const setOpen = (v) => {
    document.body.classList.toggle('nav-open', v)
    navToggle.setAttribute('aria-expanded', v ? 'true' : 'false')
  }
  navToggle.addEventListener('click', () => setOpen(!document.body.classList.contains('nav-open')))
  navLinks.addEventListener('click', (e) => { if (e.target.tagName === 'A') setOpen(false) }) // 링크 누르면 닫힘
}

// 관리자로 로그인돼 있으면 내비에 Admin 링크 표시 (방문자에게는 안 보임)
api('/me').then(({ admin }) => {
  if (!admin) return
  const a = document.createElement('a')
  a.href = 'admin.html'
  a.textContent = 'Admin'
  document.querySelector('.nav-links').appendChild(a)
}).catch(() => {})

// ---------- home ----------
let featureTimer = null

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// 사진의 컬렉션(+폴더 포커스) 링크
function featureHref(p) {
  return '#/c/' + p.collection_id + (p.group_id ? '/g' + p.group_id : '')
}

// 모델 표기 규칙: 닉네임이 주, 계정(@핸들)은 작게 보조로.
// 여러 명이면 닉네임은 &, 계정은 , 로 구분합니다.
function modelCreditHtml(p) {
  const handles = p.models || []
  if (!handles.length) return ''
  const names = handles.map((handle, index) => (p.model_names || [])[index])
  const accounts = `<span class="handle">${handles.map((h) => '@' + esc(h)).join(', ')}</span>`
  if (!names.every(Boolean)) return accounts
  return `${names.map(esc).join(' &amp; ')} ${accounts}`
}
// 스크린리더·alt용 평문
function modelCreditText(p) {
  return (p.models || []).map((handle, index) => (p.model_names || [])[index] || '@' + handle).join(' & ')
}

// 스크린리더·검색엔진용 사진 설명. 폴더 크레딧이 붙은 사진은 모델·캐릭터까지 담습니다.
function photoAltText(p) {
  const models = (p._modelNames || []).filter(Boolean).join(', ') || (p._models || []).join(', ')
  return [p._event || p.title, models, p._character || p.character].filter(Boolean).join(' · ')
}

// 랜덤 모드: 전체 사진 셔플 순환, 한 바퀴 돌기 전엔 반복 없음. 캡션은 행사명 + 모델(+캐릭터)
// 스와이프/드래그로 수동 넘기기 가능, 캡션은 페이드 전환
function startRandomFeature(deck) {
  const holder = document.querySelector('.feature-img')
  const link = document.getElementById('featureLink')
  if (!holder || !link || deck.length < 2) return
  let idx = 0
  const imgA = holder.querySelector('img')
  const imgB = imgA.cloneNode()
  imgB.style.opacity = '0'
  holder.appendChild(imgB)
  let front = imgA, back = imgB
  let busy = false

  const setCaption = (p) => {
    if (!document.body.contains(link)) return
    link.href = featureHref(p)
    const info = link.querySelector('.feature-info')
    info.classList.add('swap') // 페이드아웃
    setTimeout(() => {
      link.querySelector('.name').textContent = p.title
      link.querySelector('.models').innerHTML = modelCreditHtml(p)
      link.querySelector('.character').textContent = p.character || ''
      info.classList.remove('swap') // 페이드인
    }, 420)
  }

  const show = (dir) => {
    if (busy) return
    busy = true
    startTimer() // 자동이든 수동이든, 전환이 일어난 순간부터 다음 자동 넘김을 다시 셉니다
    if (dir > 0) {
      idx++
      if (idx >= deck.length) {
        // 한 바퀴 끝 — 다시 섞되 직전 사진 연속 방지
        const last = deck[deck.length - 1]
        shuffle(deck)
        if (deck.length > 1 && deck[0] === last) [deck[0], deck[1]] = [deck[1], deck[0]]
        idx = 0
      }
    } else {
      idx = (idx - 1 + deck.length) % deck.length
    }
    const p = deck[idx]
    back.src = '/img/' + (p.key_medium || p.key_large)
    let swapped = false
    const swap = () => {
      if (swapped) return
      swapped = true
      back.style.opacity = '1'
      front.style.opacity = '0'
      ;[front, back] = [back, front]
      setCaption(p)
      busy = false
    }
    // decode가 지연/실패해도 잠기지 않게 타임아웃 폴백
    if (back.decode) {
      back.decode().then(swap).catch(swap)
      setTimeout(swap, 900)
    } else swap()
  }

  const startTimer = () => {
    if (featureTimer) clearInterval(featureTimer)
    featureTimer = setInterval(() => {
      if (document.hidden || !document.body.contains(holder)) return
      show(1)
    }, 5000)
  }
  startTimer()

  // 터치 스와이프 + 마우스 드래그 (탭/클릭과 구분: 수평 이동 35px 이상)
  let sx = 0, sy = 0, tracking = false, swiped = false
  const begin = (x, y) => { sx = x; sy = y; tracking = true }
  const finish = (x, y) => {
    if (!tracking) return
    tracking = false
    const dx = x - sx, dy = y - sy
    if (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy)) {
      swiped = true
      show(dx < 0 ? 1 : -1) // 타이머 리셋은 show() 안에서
    } else if (Math.abs(dx) > 10) {
      // 문턱에 못 미친 짧은 플릭 — 슬라이드는 안 넘기더라도, 만진 직후
      // 자동 넘김이 튀어나오지 않게 카운트다운은 다시 셉니다.
      startTimer()
    }
  }
  link.addEventListener('touchstart', (e) => begin(e.touches[0].clientX, e.touches[0].clientY), { passive: true })
  link.addEventListener('touchend', (e) => finish(e.changedTouches[0].clientX, e.changedTouches[0].clientY), { passive: true })
  link.addEventListener('mousedown', (e) => begin(e.clientX, e.clientY))
  link.addEventListener('mouseup', (e) => finish(e.clientX, e.clientY))
  link.addEventListener('dragstart', (e) => e.preventDefault())
  link.addEventListener('click', (e) => {
    if (swiped) { e.preventDefault(); swiped = false } // 스와이프였다면 링크 이동 취소
  })
}

// 메인 사진을 컬렉션 사진들로 천천히 크로스페이드
async function startFeatureRotation(colId, coverKey) {
  const holder = document.querySelector('.feature-img')
  if (!holder) return
  const col = await api('/collections/' + colId)
  const keys = col.photos.map((p) => p.key_medium || p.key_large)
  if (keys.length < 2) return
  let i = Math.max(0, keys.indexOf(coverKey))
  const imgA = holder.querySelector('img')
  const imgB = imgA.cloneNode()
  imgB.style.opacity = '0'
  holder.appendChild(imgB)
  let front = imgA, back = imgB
  featureTimer = setInterval(() => {
    if (document.hidden || !document.body.contains(holder)) return
    i = (i + 1) % keys.length
    back.src = '/img/' + keys[i]
    const swap = () => {
      back.style.opacity = '1'
      front.style.opacity = '0'
      ;[front, back] = [back, front]
    }
    back.decode ? back.decode().then(swap).catch(swap) : swap()
  }, 5000)
}

// 컬렉션 카드 HTML
function shootTypeOf(c) {
  return c?.shoot_type === 'session' ? 'session' : 'event'
}
function shootTypeLabel(c) {
  return shootTypeOf(c) === 'session' ? 'Personal Session' : 'Event'
}
function locationLabel(value) {
  return ({ venue: 'Event venue', outdoor: 'Outdoor', studio: 'Studio' }[value] || '')
}
function cardHtml(c) {
  const type = shootTypeOf(c)
  const info = type === 'session'
    ? [locationLabel(c.location_type), `${c.photo_count} photos`].filter(Boolean).join(' · ')
    : [c.date, `${c.photo_count} photos`].filter(Boolean).join(' · ')
  return `
    <a class="card card--${type}" href="#/c/${c.id}">
      <div class="cover" ${c.cover_w && c.cover_h ? `style="aspect-ratio:${c.cover_w}/${c.cover_h}"` : ''}>
        <img src="/img/${esc(c.cover_medium || c.cover_large || c.cover_thumb)}" alt="${esc(c.title)}" loading="lazy" data-fade />
      </div>
      ${type === 'event' && (c.preview_thumbs || []).length ? `<div class="strip">
        ${c.preview_thumbs.map((k, i) => {
          const extra = c.photo_count - 1 - c.preview_thumbs.length
          const isLast = i === c.preview_thumbs.length - 1
          return `<div class="s"><img src="/img/${esc(k)}" loading="lazy" data-fade />${isLast && extra > 0 ? `<span>+${extra}</span>` : ''}</div>`
        }).join('')}
      </div>` : ''}
      <div class="meta">
        <div class="info">${esc(shootTypeLabel(c))}${info ? ` · ${esc(info)}` : ''}</div>
        <div class="title">${esc(c.title)}</div>
      </div>
    </a>`
}

// 카드 masonry 배치: 읽는 순서(왼→오)를 지키며 가장 짧은 열에 순서대로 넣기
let homeCollections = { event: [], session: [] }
function syncCollectionToggle(wrap) {
  const button = document.querySelector('.collection-toggle[aria-controls="' + wrap.id + '"]')
  if (!button) return
  const shell = wrap.closest('.collection-list-shell')
  const expanded = wrap.dataset.expanded === 'true'
  shell?.classList.toggle('is-expanded', expanded)
  const foldHeight = parseFloat(getComputedStyle(wrap).getPropertyValue('--collection-fold-y'))
  // 애니메이션 중에도 실제 전체 높이와 접힘 기준을 비교해 버튼 상태를 안정적으로 계산합니다.
  const hasOverflow = Number.isFinite(foldHeight)
    ? wrap.scrollHeight > Math.ceil(foldHeight) + 8
    : wrap.scrollHeight > Math.ceil(wrap.clientHeight) + 8
  wrap.classList.toggle('is-overflowing', hasOverflow)
  wrap.dataset.hasOverflow = String(hasOverflow)
  button.hidden = !hasOverflow
}
function animateCollectionToggle(wrap, button, expanded) {
  wrap._collectionAnimationCleanup?.()

  const currentHeight = wrap.getBoundingClientRect().height
  const computed = getComputedStyle(wrap)
  const foldHeight = parseFloat(computed.getPropertyValue('--collection-fold-y')) || currentHeight
  const targetHeight = expanded ? wrap.scrollHeight : Math.min(foldHeight, wrap.scrollHeight)
  const shell = wrap.closest('.collection-list-shell')

  wrap.dataset.expanded = String(expanded)
  wrap.classList.add('is-animating')
  wrap.style.maxHeight = `${currentHeight}px`
  wrap.classList.toggle('is-collapsed', !expanded)
  shell?.classList.toggle('is-expanded', expanded)
  button.setAttribute('aria-expanded', String(expanded))
  button.setAttribute('aria-label', expanded ? '컬렉션 접기' : '컬렉션 더보기')
  button.title = expanded ? '접기' : '더보기'
  button.classList.toggle('is-expanded', expanded)
  const arrow = button.querySelector('.collection-toggle-arrow')
  if (arrow) arrow.textContent = expanded ? '↑' : '↓'
  button.hidden = false

  let finished = false
  const cleanup = () => {
    if (finished) return
    finished = true
    wrap.removeEventListener('transitionend', onEnd)
    wrap._collectionAnimationCleanup = null
    wrap.style.removeProperty('max-height')
    wrap.classList.remove('is-animating')
    syncCollectionToggle(wrap)
  }
  const onEnd = (event) => {
    if (event.target === wrap && event.propertyName === 'max-height') cleanup()
  }
  wrap._collectionAnimationCleanup = cleanup
  wrap.addEventListener('transitionend', onEnd)
  requestAnimationFrame(() => {
    if (!finished) wrap.style.maxHeight = `${targetHeight}px`
  })
}
function layoutCollections(force) {
  document.querySelectorAll('.collections[data-kind]').forEach((wrap) => {
    wrap._collectionAnimationCleanup?.()
    const kind = wrap.dataset.kind === 'session' ? 'session' : 'event'
    const allItems = homeCollections[kind] || []
    const expanded = wrap.dataset.expanded === 'true'
    const items = allItems
    wrap.classList.toggle('is-collapsed', !expanded)
    const n = kind === 'session'
      ? (innerWidth <= 620 ? 1 : 2)
      : (innerWidth <= 980 ? 2 : 3)
    if (!force && +wrap.dataset.cols === n) return
    wrap.dataset.cols = n
    const heights = Array(n).fill(0)
    const colEls = Array.from({ length: n }, () => {
      const d = document.createElement('div')
      d.className = 'mcol'
      return d
    })
    for (const c of items) {
      const i = heights.indexOf(Math.min(...heights))
      colEls[i].insertAdjacentHTML('beforeend', cardHtml(c))
      // 카드 높이 추정 (열 폭 기준 비율): 커버 + 행사 썸네일 스트립 + 텍스트
      const coverH = c.cover_w && c.cover_h ? c.cover_h / c.cover_w : 0.75
      heights[i] += coverH + (kind === 'event' && (c.preview_thumbs || []).length ? 0.36 : 0) + 0.28
    }
    wrap.replaceChildren(...colEls)
    syncCollectionToggle(wrap)
  })
  markLoadedImages()
}
window.addEventListener('resize', () => layoutCollections(false))

async function renderHome() {
  const [cols, settings] = await Promise.all([api('/collections'), api('/settings')])
  const visible = cols.filter((c) => c.photo_count > 0)
  const collectionsByType = {
    event: visible.filter((c) => shootTypeOf(c) === 'event'),
    session: visible.filter((c) => shootTypeOf(c) === 'session'),
  }
  // 관리자가 지정한 컬렉션이 있으면 그 컬렉션 고정, 없으면 전체 사진 랜덤 순환
  const featured = visible.find((c) => c.id === settings.featured_collection_id)
  let deck = null
  if (!featured && visible.length) {
    deck = shuffle(await api('/feature-photos'))
  }

  const headlineHtml = (SITE.headline || '').split('\n').map(esc).join('<br/>')
  // 하나의 히어로 — 인트로 모드에선 닉네임이 위에 붙고, 스크롤하면 닉네임만 잘리고 아래가 빠르게 쫓아옴
  const hero = `
    <section class="hero">
      <div class="hero-head">
        <div class="hi-nick">${esc(SITE.name || 'KANEZ')}</div>
        ${SITE.kicker ? `<div class="kicker">${esc(SITE.kicker)}</div>` : ''}
        <h2 class="headline">${headlineHtml}</h2>
      </div>
      <div class="hero-foot">
        <p class="intro">${esc(SITE.intro || '')}</p>
        ${SITE.twitter ? `<a class="sns" href="https://x.com/${esc(SITE.twitter)}" target="_blank" rel="noopener">@${esc(SITE.twitter)} ↗</a>` : ''}
      </div>
    </section>
    <div class="hero-scroll" aria-hidden="true">Scroll ↓</div>`

  let cover = ''
  if (featured && featured.cover_large) {
    // 지정 모드: 컬렉션 정보 패널
    cover = `
    <a class="feature" href="#/c/${featured.id}">
      <div class="feature-img"><img src="/img/${esc(featured.cover_medium || featured.cover_large)}" alt="${esc(featured.title)}" fetchpriority="high" /></div>
      <div class="feature-info">
        <div class="label">Featured Collection</div>
        <div class="name">${esc(featured.title)}</div>
        <div class="date">${esc(featured.date)}${featured.date ? ' · ' : ''}${featured.photo_count} photos</div>
        ${featured.description ? `<p class="desc">${esc(featured.description)}</p>` : ''}
        <span class="view">보러가기 →</span>
      </div>
    </a>`
  } else if (deck && deck.length) {
    // 랜덤 모드: 행사명 + 모델만 작게
    const p = deck[0]
    cover = `
    <a class="feature" id="featureLink" href="${featureHref(p)}">
      <div class="feature-img"><img src="/img/${esc(p.key_medium || p.key_large)}" alt="${esc(p.title)}" fetchpriority="high" /></div>
      <div class="feature-info">
        <div class="label">Gallery</div>
        <div class="name">${esc(p.title)}</div>
        <div class="date models">${modelCreditHtml(p)}</div>
        <div class="character">${esc(p.character || '')}</div>
      </div>
    </a>`
  }

  const sectionOrder = settings.home_section_order === 'sessions_first'
    ? ['session', 'event']
    : ['event', 'session']
  const sectionTitles = { event: 'Events', session: 'Personal Sessions' }
  const collectionSections = sectionOrder.map((kind) => {
    const items = collectionsByType[kind]
    if (!items.length) return ''
    const listId = 'collections-' + kind
    return `
      <section class="collection-block collection-block--${kind}">
        <div class="collection-block-head">
          <div class="collection-block-title">
            <h3>${sectionTitles[kind]}</h3>
            <div class="date">${items.length} collections</div>
          </div>
        </div>
        <div class="collection-list-shell">
          <div id="${listId}" class="collections is-collapsed" data-kind="${kind}" data-expanded="false"></div>
          ${'<button type="button" class="collection-toggle" aria-label="컬렉션 더보기" title="더보기" aria-controls="' + listId + '" aria-expanded="false" hidden>' +
            '<span class="collection-toggle-arrow" aria-hidden="true">↓</span>' +
          '</button>'}
        </div>
      </section>`
  }).join('')
  const grid = visible.length ? `
    <section id="collections" class="collection-index">
      <div class="col-head">
        <h2>Collections</h2>
        <div class="date">${visible.length} collections · <a href="#/photos">All photos →</a></div>
      </div>
      ${collectionSections}
    </section>` : '<div class="empty">아직 게시된 사진이 없습니다</div>'

  // 하단 About 티저: 짧은 소개 + 연락 버튼 + 더 보기
  const aboutData = settings.about || SITE.about || {}
  const teaserText = (aboutData.intro && aboutData.intro[0]) || SITE.intro || ''
  const teaser = `
    <section class="about-teaser" id="contact">
      <div class="sec-kicker"><span>About</span></div>
      <p class="about-p">${esc(teaserText)}</p>
      <div class="contact-links">
        ${SITE.twitter ? `<a href="https://x.com/${esc(SITE.twitter)}" target="_blank" rel="noopener">@${esc(SITE.twitter)} ↗</a>` : ''}
        ${SITE.email ? `<a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a>` : ''}
        <a href="#/about">더 보기 →</a>
      </div>
    </section>`

  main.innerHTML = hero + '<div class="below-hero">' + cover + grid + teaser + '</div>'
  homeCollections = collectionsByType
  layoutCollections(true)
  main.querySelectorAll('.collection-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const wrap = document.getElementById(button.getAttribute('aria-controls'))
      if (!wrap) return
      const expanded = wrap.dataset.expanded !== 'true'
      animateCollectionToggle(wrap, button, expanded)
    })
  })
  if (featured && featured.cover_large) startFeatureRotation(featured.id, featured.cover_medium || featured.cover_large)
  else if (deck) startRandomFeature(deck)
}

// ---------- collection ----------
let current = null // { photos, index } — 라이트박스가 넘겨볼 사진 목록

// ---------- justified 행 배치: 가로 줄 단위로 꽉 차게, 빈칸 없음 ----------
let jSets = null // [{ photos, offset }] — 현재 컬렉션 페이지의 각 그리드
let jLastW = 0

function aspectOf(p) {
  return p.width && p.height ? p.width / p.height : 0.75
}

function justifiedHtml(photos, offset, containerW) {
  const targetH = containerW < 640 ? 240 : 340 // 목표 줄 높이(px)
  const threshold = containerW / targetH // 한 줄의 비율 합 목표
  const rows = []
  let row = [], sum = 0
  photos.forEach((p, i) => {
    row.push({ p, i: offset + i })
    sum += aspectOf(p)
    if (sum >= threshold) { rows.push({ row, sum }); row = []; sum = 0 }
  })
  if (row.length) rows.push({ row, sum, last: true })

  return rows.map(({ row, sum, last }) => {
    // 마지막 줄이 많이 비면 확대하지 않고 빈 공간으로 채움 (사진이 과하게 커지는 것 방지)
    const fill = last && sum < threshold * 0.65 ? threshold - sum : 0
    return `<div class="jrow">${row.map(({ p, i }) => `
      <button type="button" class="ph" data-i="${i}" aria-label="${esc(photoAltText(p) || '사진')} 크게 보기" style="flex-grow:${aspectOf(p).toFixed(4)}; aspect-ratio:${p.width || 3}/${p.height || 4}">
        <img src="/img/${esc(p.key_thumb)}" alt="${esc(photoAltText(p))}" loading="lazy" data-fade />
      </button>`).join('')}${fill ? `<div class="jfill" style="flex-grow:${fill.toFixed(4)}"></div>` : ''}</div>`
  }).join('')
}

function layoutJustifiedAll() {
  if (!jSets) return
  const grids = document.querySelectorAll('.jgrid')
  if (!grids.length) return
  const w = grids[0].clientWidth
  if (!w) return
  jLastW = w
  grids.forEach((el, gi) => {
    const set = jSets[gi]
    if (set) el.innerHTML = justifiedHtml(set.photos, set.offset, w)
  })
  markLoadedImages()
}
window.addEventListener('resize', () => {
  const g = document.querySelector('.jgrid')
  if (g && Math.abs(g.clientWidth - jLastW) > 40) layoutJustifiedAll()
})

function sessionPhotoHtml(p, i, extraClass = '') {
  return `<button type="button" class="ph ${extraClass}" data-i="${i}" aria-label="${esc(photoAltText(p) || '사진')} 크게 보기" style="aspect-ratio:${p.width || 3}/${p.height || 4}">
    <img src="/img/${esc(p.key_medium || p.key_large || p.key_thumb)}" alt="${esc(photoAltText(p))}" loading="lazy" data-fade />
  </button>`
}

function sessionGalleryHtml(photos) {
  if (!photos.length) return ''
  const [lead, ...rest] = photos
  const gridClass = rest.length === 1 ? ' is-single' : rest.length % 2 ? ' is-odd' : ''
  return `<div class="session-gallery">
    <div class="session-lead">${sessionPhotoHtml(lead, 0)}</div>
    ${rest.length ? `<div class="session-grid${gridClass}">${rest.map((p, i) => sessionPhotoHtml(p, i + 1)).join('')}</div>` : ''}
  </div>`
}

function sessionModelHtml(sections) {
  if (!sections.length) return ''
  const models = sections.map((s) => {
    const handles = s.handles || []
    const names = (s.modelNames || []).filter(Boolean)
    const displayName = names.join(' & ') || s.name
    const nameHtml = handles.length === 1
      ? `<a href="#/m/${esc(handles[0])}" title="이 모델 사진 모아보기">${esc(displayName)}</a>`
      : esc(displayName)
    const handleHtml = handles.map((h) =>
      `<a href="https://x.com/${esc(h)}" target="_blank" rel="noopener">@${esc(h)} ↗</a>`).join(', ')
    const detail = [handleHtml, s.character ? `<span class="chr${handles.length ? '' : ' chr--alone'}">${esc(s.character)}</span>` : '']
      .filter(Boolean).join('')
    return `<div class="session-model">
      <div class="session-model-name">${nameHtml}</div>
      ${detail ? `<div class="session-model-detail">${detail}</div>` : ''}
    </div>`
  }).join('')
  return `<div class="session-models" aria-label="Models">${models}</div>`
}

async function renderCollection(id, focusGroup = null) {
  const col = await api('/collections/' + id)
  const ungrouped = col.photos.filter((p) => !p.group_id)
  // 사진 있는 폴더만 노출
  const sections = (col.groups || [])
    .map((g) => ({ ...g, photos: col.photos.filter((p) => p.group_id === g.id) }))
    .filter((g) => g.photos.length)
  // 폴더에 모델 계정이 있으면 사진에 크레딧 부착 (라이트박스 표시용, 여러 명 가능)
  for (const s of sections) {
    s.handles = [].concat((s.meta && s.meta.twitter) || []) // 옛 문자열 형식도 배열로
    s.modelNames = [].concat(s.model_names || [])
    s.character = (s.meta && s.meta.character) || ''
    s.photos.forEach((p) => {
      if (s.handles.length) p._models = s.handles
      if (s.modelNames.length) p._modelNames = s.modelNames
      if (s.character) p._character = s.character
    })
  }
  // 라이트박스용 사진 목록: 표시 순서 그대로 하나로 이어붙임 (폴더가 달라져도 계속 넘어감)
  const flat = [...ungrouped, ...sections.flatMap((s) => s.photos)]
  // 행사명은 alt 텍스트와 라이트박스 설명에 쓰입니다(Photos 페이지와 같은 형태로 맞춤).
  for (const p of flat) p._event = col.title

  if (shootTypeOf(col) === 'session') {
    jSets = null
    const facts = [col.date, locationLabel(col.location_type), `${flat.length} photos`].filter(Boolean).join(' · ')
    const models = sessionModelHtml(sections)
    const related = col.related_event_id && col.related_event_title
      ? `<a class="related-event" href="#/c/${col.related_event_id}">From Events · ${esc(col.related_event_title)}${col.related_event_date ? ` · ${esc(col.related_event_date)}` : ''} →</a>`
      : ''
    main.innerHTML = `
      <div class="col-head session-head">
        <a class="back" href="#/">← Personal Sessions</a>
        <div class="shoot-kind">Personal Session</div>
        <h2>${esc(col.title)}</h2>
        ${models}
        ${facts ? `<div class="date">${esc(facts)}</div>` : ''}
        ${col.description ? `<div class="desc">${esc(col.description)}</div>` : ''}
        ${related}
      </div>
      ${flat.length ? sessionGalleryHtml(flat) : '<div class="empty">사진이 없습니다</div>'}
      ${flat.length ? `<div class="col-share">
        <button type="button" class="share-collection" aria-label="세션 공유 링크 복사">이 세션 공유 ↗</button>
      </div>` : ''}`
    main.querySelector('.share-collection')?.addEventListener('click', async (ev) => {
      const shareUrl = `${location.origin}/share/collection/${encodeURIComponent(id)}`
      try {
        if (!navigator.clipboard) throw new Error('Clipboard API unavailable')
        await navigator.clipboard.writeText(shareUrl)
        const button = ev.currentTarget
        button.textContent = '링크 복사됨'
        setTimeout(() => { button.textContent = '이 세션 공유 ↗' }, 1600)
      } catch {
        window.prompt('공유 링크를 복사하세요:', shareUrl)
      }
    })
    main.onclick = (ev) => {
      const el = ev.target.closest('.ph')
      if (!el) return
      current = { photos: flat, index: 0 }
      openLightbox(+el.dataset.i)
    }
    return
  }

  // 섹션별 justified 그리드 데이터 (.jgrid 순서와 1:1)
  jSets = []
  let offset = 0
  if (ungrouped.length) {
    jSets.push({ photos: ungrouped, offset })
    offset += ungrouped.length
  }
  const sectionBlocks = sections.map((s) => {
    jSets.push({ photos: s.photos, offset })
    offset += s.photos.length
    return `
      <section class="group-sec">
        <h3 class="group-name">${s.handles.length === 1
          ? `<a href="#/m/${esc(s.handles[0])}" title="이 모델 사진 모아보기">${esc(s.name)}</a>`
          : esc(s.name)}</h3>
        ${s.handles.length || s.character ? `<div class="group-credit">${s.handles.map((h) =>
          `<a href="https://x.com/${esc(h)}" target="_blank" rel="noopener">@${esc(h)} ↗</a>`).join(', ')}${
          s.character ? `<span class="chr">${esc(s.character)}</span>` : ''}</div>` : ''}
        <div class="jgrid"></div>
      </section>`
  })

  // 보기 모드: 사람별(people) / 전체(all) — 방문자 선택 기억
  // 폴더 포커스 링크로 들어오면 Model 뷰로 강제 (저장된 선택은 안 건드림)
  const viewMode = sections.length && !focusGroup && localStorage.getItem('pht-view') === 'all' ? 'all' : 'people'
  if (viewMode === 'all') {
    jSets = [{ photos: flat, offset: 0 }]
  }

  main.innerHTML = `
    <div class="col-head">
      <a class="back" href="#/">← Collections</a>
      <h2>${esc(col.title)}</h2>
      ${col.date ? `<div class="date">${esc(col.date)}</div>` : ''}
      ${col.description ? `<div class="desc">${esc(col.description)}</div>` : ''}
      ${sections.length ? `<div class="view-toggle">
        <button data-view="people" class="${viewMode === 'people' ? 'on' : ''}">Model</button>
        <button data-view="all" class="${viewMode === 'all' ? 'on' : ''}">All</button>
      </div>` : ''}
    </div>
    ${!col.photos.length ? '<div class="empty">사진이 없습니다</div>' : ''}
    ${viewMode === 'all'
      ? '<div class="jgrid"></div>'
      : `${ungrouped.length ? '<div class="jgrid"></div>' : ''}${sectionBlocks.join('')}`}
    ${col.photos.length ? `<div class="col-share">
      <button type="button" class="share-collection" aria-label="컬렉션 공유 링크 복사">이 컬렉션 공유 ↗</button>
    </div>` : ''}`

  layoutJustifiedAll()

  main.querySelectorAll('.view-toggle button').forEach((b) =>
    b.addEventListener('click', () => {
      localStorage.setItem('pht-view', b.dataset.view)
      renderCollection(id)
    }))

  main.querySelector('.share-collection')?.addEventListener('click', async (ev) => {
    const shareUrl = `${location.origin}/share/collection/${encodeURIComponent(id)}`
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(shareUrl)
      const button = ev.currentTarget
      button.textContent = '링크 복사됨'
      setTimeout(() => { button.textContent = '이 컬렉션 공유 ↗' }, 1600)
    } catch {
      window.prompt('공유 링크를 복사하세요:', shareUrl)
    }
  })

  // 폴더 포커스: 해당 사람 섹션으로 스크롤 + 잠깐 하이라이트
  if (focusGroup) {
    const gi = sections.findIndex((s) => s.id === focusGroup)
    if (gi >= 0) {
      const secEl = main.querySelectorAll('.group-sec')[gi]
      setTimeout(() => {
        secEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
        secEl.classList.add('flash')
      }, 150)
    }
  }

  // 클릭 위임 (리사이즈로 그리드가 다시 그려져도 동작)
  main.onclick = (ev) => {
    const el = ev.target.closest('.ph')
    if (!el) return
    current = { photos: flat, index: 0 }
    openLightbox(+el.dataset.i)
  }
}

// ---------- lightbox ----------
function exifLine(p) {
  const e = p.exif || {}
  const parts = []
  if (e.Model) parts.push(e.Model)
  if (e.LensModel) parts.push(e.LensModel)
  if (e.FocalLength) parts.push(Math.round(e.FocalLength) + 'mm')
  if (e.FNumber) parts.push('f/' + e.FNumber)
  if (e.ExposureTime) parts.push(e.ExposureTime >= 1 ? e.ExposureTime + 's' : '1/' + Math.round(1 / e.ExposureTime) + 's')
  if (e.ISO) parts.push('ISO ' + e.ISO)
  if (p.taken_at) parts.push(p.taken_at.slice(0, 10))
  return parts.join(' · ')
}

function openLightbox(i) {
  current.index = i
  const opener = document.activeElement // 닫은 뒤 이 사진으로 포커스를 되돌립니다.
  const box = document.createElement('div')
  box.className = 'lightbox'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.setAttribute('aria-label', '사진 크게 보기')
  box.innerHTML = `
    <span class="count"></span>
    <div class="image-stage">
      <img class="lb-image active" />
      <img class="lb-image" />
    </div>
    <div class="exif"></div>
    <button class="nav-arrow prev" aria-label="이전">‹</button>
    <button class="nav-arrow next" aria-label="다음">›</button>
    <button class="close" aria-label="닫기">×</button>`
  document.body.appendChild(box)
  document.body.style.overflow = 'hidden'

  let activeImage = box.querySelector('.lb-image.active')
  let transitioning = false

  const updateInfo = () => {
    const p = current.photos[current.index]
    const exifEl = box.querySelector('.exif')
    exifEl.textContent = [p._event, exifLine(p)].filter(Boolean).join(' · ')
    for (const [index, handle] of (p._models || []).entries()) {
      // 모델(코스어) 크레딧 링크 (여러 명 가능)
      if (exifEl.textContent || exifEl.querySelector('a')) exifEl.appendChild(document.createTextNode(' · '))
      const modelName = (p._modelNames || [])[index]
      if (modelName) exifEl.appendChild(document.createTextNode(modelName + ' '))
      const a = document.createElement('a')
      a.href = 'https://x.com/' + handle
      a.target = '_blank'
      a.rel = 'noopener'
      a.textContent = '@' + handle + ' ↗'
      exifEl.appendChild(a)
    }
    if (p._character) {
      if (exifEl.textContent || exifEl.querySelector('a')) exifEl.appendChild(document.createTextNode(' · '))
      exifEl.appendChild(document.createTextNode(p._character))
    }
    box.querySelector('.count').textContent = `${current.index + 1} / ${current.photos.length}`
  }

  const preloadNearby = () => {
    for (const d of [-1, 1]) {
      const p = current.photos[(current.index + d + current.photos.length) % current.photos.length]
      const image = new Image()
      image.src = '/img/' + p.key_large
    }
  }

  const show = async (direction = 0) => {
    const p = current.photos[current.index]
    if (!direction) {
      activeImage.src = '/img/' + p.key_large
      updateInfo()
      preloadNearby()
      return
    }

    const outgoing = activeImage
    const incoming = [...box.querySelectorAll('.lb-image')].find((image) => image !== outgoing)
    let finished = false
    const finish = (event) => {
      if (event?.propertyName && event.propertyName !== 'transform') return
      if (finished) return
      finished = true
      clearTimeout(fallback)
      incoming.removeEventListener('transitionend', finish)
      outgoing.className = 'lb-image'
      outgoing.removeAttribute('src')
      incoming.className = 'lb-image active'
      activeImage = incoming
      transitioning = false
    }

    incoming.className = `lb-image from-${direction > 0 ? 'right' : 'left'}`
    incoming.src = '/img/' + p.key_large
    if (incoming.decode) await incoming.decode().catch(() => {})
    incoming.addEventListener('transitionend', finish)
    // 시작 위치를 확정한 뒤 전환 클래스를 붙여 CSS transition을 보장합니다.
    void incoming.offsetWidth
    incoming.classList.add('active')
    outgoing.classList.remove('active')
    outgoing.classList.add(direction > 0 ? 'exit-left' : 'exit-right')
    updateInfo()
    preloadNearby()
    // transitionend가 오지 않는 예외 환경에서도 탐색이 잠기지 않게 합니다.
    const fallback = setTimeout(finish, 500)
  }

  const move = (d) => {
    if (transitioning) return
    transitioning = true
    current.index = (current.index + d + current.photos.length) % current.photos.length
    show(d)
  }
  // 히스토리 항목을 하나 밀어넣어 모바일 뒤로가기가 사이트를 떠나지 않고 라이트박스만 닫게 합니다.
  // URL은 그대로 두므로 해시 라우터가 다시 렌더하지 않습니다.
  let historyPushed = false
  try {
    history.pushState({ lightbox: true }, '', location.href)
    historyPushed = true
  } catch { /* pushState를 못 쓰는 환경에서는 기존 동작 유지 */ }

  let closed = false
  const teardown = () => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('popstate', onPopState)
    document.body.style.overflow = ''
    box.remove()
    if (opener && document.contains(opener)) opener.focus()
  }
  const onPopState = () => teardown() // 뒤로가기: 이미 항목이 소비됐으므로 정리만 합니다.
  // 버튼·Escape로 닫을 때는 우리가 넣은 히스토리 항목을 되감아 뒤로가기 횟수가 늘지 않게 합니다.
  const close = () => {
    if (closed) return
    if (historyPushed && history.state?.lightbox) history.back()
    else teardown()
  }
  const onKey = (ev) => {
    if (ev.key === 'Escape') close()
    else if (ev.key === 'ArrowLeft') move(-1)
    else if (ev.key === 'ArrowRight') move(1)
  }
  document.addEventListener('keydown', onKey)
  window.addEventListener('popstate', onPopState)
  box.querySelector('.prev').addEventListener('click', () => move(-1))
  box.querySelector('.next').addEventListener('click', () => move(1))
  box.querySelector('.close').addEventListener('click', close)
  box.addEventListener('click', (ev) => { if (ev.target === box) close() })
  box.querySelector('.close').focus() // 포커스를 모달 안으로 옮깁니다.

  // 터치 스와이프: 좌우 = 이전/다음, 아래로 크게 = 닫기
  let touchX = 0, touchY = 0
  box.addEventListener('touchstart', (ev) => {
    touchX = ev.touches[0].clientX
    touchY = ev.touches[0].clientY
  }, { passive: true })
  box.addEventListener('touchend', (ev) => {
    const dx = ev.changedTouches[0].clientX - touchX
    const dy = ev.changedTouches[0].clientY - touchY
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1)
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) close()
  }, { passive: true })
  show()
}

// ---------- 전체 사진 (Photos) ----------
let photosMore = null // { offset, total, loading }

function decoratePhoto(p) {
  if (p.models.length) p._models = p.models
  if (p.model_names?.length) p._modelNames = p.model_names
  if (p.character) p._character = p.character
  p._event = p.title // 라이트박스에 행사명 표시
  return p
}

async function renderPhotos() {
  const first = await api('/photos?offset=0&limit=60')
  const photos = first.photos.map(decoratePhoto)
  jSets = [{ photos, offset: 0 }]
  photosMore = { offset: photos.length, total: first.total, loading: false }
  main.innerHTML = `
    <div class="col-head">
      <a class="back" href="#/">← Home</a>
      <h2>Photos</h2>
      <div class="date">${first.total} photos</div>
    </div>
    ${photos.length ? '<div class="jgrid"></div>' : '<div class="empty">아직 사진이 없습니다</div>'}`
  layoutJustifiedAll()
  main.onclick = (ev) => {
    const el = ev.target.closest('.ph')
    if (!el) return
    current = { photos: jSets[0].photos, index: 0 }
    openLightbox(+el.dataset.i)
  }
}

// 무한 스크롤: 바닥 근처에서 다음 60장 로드
window.addEventListener('scroll', async () => {
  if ((location.hash || '') !== '#/photos' || !photosMore || photosMore.loading) return
  if (photosMore.offset >= photosMore.total) return
  if (innerHeight + scrollY < document.body.scrollHeight - 600) return
  photosMore.loading = true
  try {
    const r = await api(`/photos?offset=${photosMore.offset}&limit=60`)
    jSets[0].photos.push(...r.photos.map(decoratePhoto))
    photosMore.offset += r.photos.length
    // 총 개수는 첫 페이지 응답에만 담깁니다(이후 페이지는 null). 처음 값을 그대로 유지합니다.
    if (typeof r.total === 'number') photosMore.total = r.total
    // 응답이 비면 더 받을 게 없다는 뜻이라 반복 요청을 멈춥니다.
    if (!r.photos.length) photosMore.total = photosMore.offset
    layoutJustifiedAll()
  } finally {
    photosMore.loading = false
  }
})

// ---------- 모델 아카이브 ----------
// ---------- 캐릭터 아카이브 (작품 → 캐릭터 → 사진) ----------
// 작품이 늘어나면 전부 펼치는 대신 작품 단위로 먼저 훑고, 고른 작품의 캐릭터만 봅니다.
const SERIES_SORTS = {
  name: { label: '가나다 순', apply: (list) => [...list].sort((a, b) => a.name.localeCompare(b.name, 'ko')) },
  photos: { label: '사진 많은 순', apply: (list) => [...list].sort((a, b) => b.photo_count - a.photo_count) },
}
const seriesSort = () => (SERIES_SORTS[localStorage.getItem('pht-series-sort')] ? localStorage.getItem('pht-series-sort') : 'name')
const seriesView = () => (localStorage.getItem('pht-series-view') === 'list' ? 'list' : 'grid')

// 작품명이 캐릭터명 앞에 붙어 있으면 카드에서는 떼고 보여줍니다(제목 중복 방지).
function shortCharacterName(character, seriesName) {
  if (!seriesName || character === seriesName) return character
  const escaped = seriesName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s*:\s*/g, '\\s*:\\s*')
  return character.replace(new RegExp('^' + escaped + '\\s*[-–—]\\s*'), '') || character
}

function seriesHref(name) { return '#/s/' + encodeURIComponent(name) }

async function renderCharacters() {
  const data = await api('/characters')
  const sortKey = seriesSort()
  const view = seriesView()
  const list = SERIES_SORTS[sortKey].apply(data.series)

  const gridCard = (s) => `
    <a class="model-card" href="${seriesHref(s.name)}">
      <div class="cover">${s.thumb ? `<img src="/img/${esc(s.thumb)}" alt="${esc(s.name)}" loading="lazy" data-fade />` : ''}</div>
      <div class="meta">
        <div class="title">${esc(s.name || '작품 미지정')}</div>
        <div class="info">${s.characters.length} characters · ${s.photo_count} photos</div>
      </div>
    </a>`
  // 목록 보기: 작품마다 제목을 두고 그 아래에 캐릭터 카드를 펼칩니다.
  const characterCard = (ch, seriesName) => `
    <a class="model-card" href="#/ch/${encodeURIComponent(ch.character)}">
      <div class="cover">${ch.thumb ? `<img src="/img/${esc(ch.thumb)}" alt="${esc(ch.character)}" loading="lazy" data-fade />` : ''}</div>
      <div class="meta">
        <div class="title">${esc(shortCharacterName(ch.character, seriesName))}</div>
        <div class="info">${ch.photo_count} photos${ch.model_names.filter(Boolean).length ? ' · ' + esc(ch.model_names.filter(Boolean).join(', ')) : ''}</div>
      </div>
    </a>`
  const listSection = (s) => {
    // 작품이 곧 캐릭터인 경우(장르 없는 캐릭터)는 제목을 겹쳐 쓰지 않습니다.
    const soloSelf = s.characters.length === 1 && s.characters[0].character === s.name
    return `<section class="series-sec">
      ${soloSelf ? '' : `<h3 class="series-head">
        <a href="${seriesHref(s.name)}">${esc(s.name || '작품 미지정')}</a>
        <span>${s.characters.length} character${s.characters.length > 1 ? 's' : ''} · ${s.photo_count} photos</span></h3>`}
      <div class="models-grid">${s.characters.map((ch) => characterCard(ch, s.name)).join('')}</div>
    </section>`
  }

  main.innerHTML = `
    <div class="col-head">
      <a class="back" href="#/">← Home</a>
      <h2>Characters</h2>
      <div class="date">${data.character_count} characters · ${data.series_count} series</div>
      <div class="head-tools">
        <div class="view-toggle">
          ${Object.entries(SERIES_SORTS).map(([key, s]) =>
            `<button data-sort="${key}" class="${key === sortKey ? 'on' : ''}">${esc(s.label)}</button>`).join('')}
        </div>
        <div class="view-mode">
          <button data-view="grid" class="${view === 'grid' ? 'on' : ''}" aria-label="작품만 그리드로 보기" title="작품만 보기">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
              <rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/>
              <rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>
            </svg>
          </button>
          <button data-view="list" class="${view === 'list' ? 'on' : ''}" aria-label="캐릭터까지 펼쳐 보기" title="캐릭터까지 펼쳐 보기">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
              <rect x="3" y="4" width="18" height="2.4" rx="1.2"/><rect x="3" y="11" width="18" height="2.4" rx="1.2"/>
              <rect x="3" y="18" width="18" height="2.4" rx="1.2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
    ${list.length
      ? (view === 'grid'
          ? `<div class="models-grid">${list.map(gridCard).join('')}</div>`
          : list.map(listSection).join(''))
      : '<div class="empty">캐릭터가 등록된 폴더가 아직 없습니다</div>'}`

  main.querySelectorAll('[data-sort]').forEach((b) =>
    b.addEventListener('click', () => { localStorage.setItem('pht-series-sort', b.dataset.sort); renderCharacters() }))
  main.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => { localStorage.setItem('pht-series-view', b.dataset.view); renderCharacters() }))
}

// 작품 상세: 그 작품의 캐릭터 카드들
async function renderSeries(name) {
  const data = await api('/characters')
  const series = data.series.find((s) => s.name === name)
  if (!series) {
    main.innerHTML = '<div class="col-head"><a class="back" href="#/characters">← Characters</a><h2>작품을 찾지 못했습니다</h2></div>'
    return
  }
  main.innerHTML = `
    <div class="col-head">
      <a class="back" href="#/characters">← Characters</a>
      <h2>${esc(series.name || '작품 미지정')}</h2>
      <div class="date">${series.characters.length} characters · ${series.photo_count} photos</div>
    </div>
    <div class="models-grid">${series.characters.map((ch) => `
      <a class="model-card" href="#/ch/${encodeURIComponent(ch.character)}">
        <div class="cover">${ch.thumb ? `<img src="/img/${esc(ch.thumb)}" alt="${esc(ch.character)}" loading="lazy" data-fade />` : ''}</div>
        <div class="meta">
          <div class="title">${esc(shortCharacterName(ch.character, series.name))}</div>
          <div class="info">${ch.photo_count} photos${ch.model_names.filter(Boolean).length ? ' · ' + esc(ch.model_names.filter(Boolean).join(', ')) : ''}</div>
        </div>
      </a>`).join('')}</div>`
}

// 캐릭터 상세: 행사별 섹션 (모델 상세와 같은 구성)
async function renderCharacter(name) {
  const ch = await api('/characters/' + encodeURIComponent(name))
  for (const s of ch.sections) {
    s.photos.forEach((p) => {
      if (s.handles.length) p._models = s.handles
      if (s.handles.length) p._modelNames = s.model_names || []
      p._character = s.character
      p._event = s.title
    })
  }
  // 같은 캐릭터를 여러 모델이 한 경우가 있으므로 모델 기준으로 묶습니다.
  // (한 폴더에 여러 모델이 함께 있으면 그 조합을 하나의 묶음으로 봅니다)
  const byModel = new Map()
  for (const s of ch.sections) {
    const key = s.handles.length ? s.handles.join(',') : ''
    const bucket = byModel.get(key) || {
      handles: s.handles,
      names: (s.model_names || []).map((n, i) => n || '@' + s.handles[i]),
      events: [],
      photos: [],
    }
    if (!bucket.events.includes(s.title)) bucket.events.push(s.title)
    bucket.photos.push(...s.photos)
    byModel.set(key, bucket)
  }
  const groups = [...byModel.values()].sort((a, b) => b.photos.length - a.photos.length)
  const flat = groups.flatMap((g) => g.photos)

  jSets = []
  let offset = 0
  const blocks = groups.map((g) => {
    jSets.push({ photos: g.photos, offset })
    offset += g.photos.length
    // 닉네임이 제목, 계정은 아래 보조줄로 작게
    const title = g.handles.length
      ? g.handles.map((h, i) => `<a href="#/m/${encodeURIComponent(h)}">${esc(g.names[i])}</a>`).join(' &amp; ')
      : '모델 미지정'
    const accounts = g.handles.length
      ? `<span class="handle">${g.handles.map((h) => '@' + esc(h)).join(', ')}</span>`
      : ''
    return `
      <section class="group-sec">
        <h3 class="group-name">${title}</h3>
        <div class="group-credit">${accounts}${accounts ? ' · ' : ''}${esc(g.events.join(' · '))} · ${g.photos.length}장</div>
        <div class="jgrid"></div>
      </section>`
  })

  main.innerHTML = `
    <div class="col-head">
      <a class="back" href="${ch.series.length ? seriesHref(ch.series[0]) : '#/characters'}">← ${esc(ch.series[0] || 'Characters')}</a>
      <h2>${esc(ch.character)}</h2>
      <div class="date">${groups.length > 1 ? `${groups.length} models · ` : ''}${ch.photo_count} photos</div>
    </div>
    ${blocks.join('') || '<div class="empty">사진이 없습니다</div>'}`
  layoutJustifiedAll()
  main.onclick = (ev) => {
    const el = ev.target.closest('.ph')
    if (!el) return
    current = { photos: flat, index: 0 }
    openLightbox(+el.dataset.i)
  }
}

async function renderModels() {
  const models = await api('/models')
  models.sort((a, b) => a.name.localeCompare(b.name, 'ko')) // 사람 찾기가 쉬우므로 가나다순 고정
  main.innerHTML = `
    <div class="col-head">
      <a class="back" href="#/">← Home</a>
      <h2>Models</h2>
      <div class="date">${models.length} people</div>
    </div>
    ${models.length ? `<div class="models-grid">${models.map((m) => `
      <a class="model-card" href="#/m/${esc(m.handle)}">
        <div class="cover">${m.cover_thumb ? `<img src="/img/${esc(m.cover_thumb)}" alt="${esc(m.name)}" loading="lazy" data-fade />` : ''}</div>
        <div class="meta">
          <div class="title">${esc(m.name)}</div>
          <div class="info">@${esc(m.handle)} · ${m.photo_count} photos</div>
        </div>
      </a>`).join('')}</div>` : '<div class="empty">모델 계정이 등록된 폴더가 아직 없습니다</div>'}`
}

async function renderModel(handle) {
  const m = await api('/models/' + encodeURIComponent(handle))
  const flat = m.sections.flatMap((s) => s.photos)
  // 크레딧/캐릭터 부착 (라이트박스용)
  for (const s of m.sections) {
    s.photos.forEach((p) => {
      if (s.handles.length) p._models = s.handles
      // 합동 폴더에서 다른 모델 핸들엔 이 페이지 모델의 이름을 붙이지 않음
      if (s.handles.length) p._modelNames = s.handles.map((h) => h.toLowerCase() === handle.toLowerCase() ? m.name : '')
      if (s.character) p._character = s.character
      p._event = s.title // 다른 페이지와 동일하게 행사명 표시
    })
  }
  jSets = []
  let offset = 0
  const blocks = m.sections.map((s) => {
    jSets.push({ photos: s.photos, offset })
    offset += s.photos.length
    return `
      <section class="group-sec">
        <h3 class="group-name"><a href="#/c/${s.collection_id}">${esc(s.title)}</a></h3>
        <div class="group-credit">${esc(s.date)}${s.character ? `<span class="chr">${esc(s.character)}</span>` : ''}</div>
        <div class="jgrid"></div>
      </section>`
  })
  main.innerHTML = `
    <div class="col-head">
      <a class="back" href="#/models">← Models</a>
      <h2>${esc(m.name)}</h2>
      <div class="date">${m.photo_count} photos</div>
      <div class="desc"><a class="model-x" href="https://x.com/${esc(m.handle)}" target="_blank" rel="noopener">@${esc(m.handle)} ↗</a></div>
    </div>
    ${blocks.join('')}`
  layoutJustifiedAll()
  main.onclick = (ev) => {
    const el = ev.target.closest('.ph')
    if (!el) return
    current = { photos: flat, index: 0 }
    openLightbox(+el.dataset.i)
  }
}

// ---------- about ----------
async function renderAbout() {
  const settings = await api('/settings')
  const a = settings.about || SITE.about || {} // Admin에서 저장한 값 우선, 없으면 config.js
  main.innerHTML = `
    <div class="col-head">
      <a class="back" href="#/">← Home</a>
      <h2>About</h2>
    </div>
    <div class="about">
      ${(a.intro || []).map((t) => `<p class="about-p">${esc(t)}</p>`).join('')}
      ${(a.gear || []).length ? `
        <div class="about-sec">Equipment</div>
        <ul class="about-gear">${a.gear.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
      ${a.note ? `
        <div class="about-sec">Contact</div>
        <p class="about-p">${esc(a.note)}</p>` : ''}
      <div class="contact-links">
        ${SITE.twitter ? `<a href="https://x.com/${esc(SITE.twitter)}" target="_blank" rel="noopener">@${esc(SITE.twitter)} ↗</a>` : ''}
        ${SITE.email ? `<a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a>` : ''}
      </div>
    </div>`
}

// ---------- router ----------
async function route() {
  if (featureTimer) { clearInterval(featureTimer); featureTimer = null }
  jSets = null
  main.onclick = null
  photosMore = null
  const hash = location.hash || '#/'
  const isHome = hash === '#/' || hash === ''
  const m = hash.match(/^#\/c\/(\d+)(?:\/g(\d+))?$/)
  const mm = hash.match(/^#\/m\/([A-Za-z0-9_]+)$/)
  const ch = hash.match(/^#\/ch\/(.+)$/) // 캐릭터명은 한글·괄호를 포함하므로 넓게 받습니다
  const sr = hash.match(/^#\/s\/(.+)$/)  // 작품(장르) 상세
  // 렌더는 데이터를 받은 뒤에 일어나므로, 그동안 이전 화면이 남아 "뒤로가기가 느린" 느낌을 줍니다.
  // 캐시가 있으면 대개 즉시 끝나니, 조금 지체될 때만 이전 화면을 비워 전환이 시작된 걸 알립니다.
  const showPending = setTimeout(() => {
    main.innerHTML = '<div class="empty" aria-live="polite">Loading…</div>'
  }, 180)
  try {
    if (m) await renderCollection(m[1], m[2] ? +m[2] : null)
    else if (hash === '#/photos') await renderPhotos()
    else if (hash === '#/models') await renderModels()
    else if (hash === '#/characters') await renderCharacters()
    else if (hash === '#/about') await renderAbout()
    else if (mm) await renderModel(mm[1])
    else if (ch) await renderCharacter(decodeURIComponent(ch[1]))
    else if (sr) await renderSeries(decodeURIComponent(sr[1]))
    else await renderHome()
  } catch (e) {
    main.innerHTML = `<div class="empty">불러오지 못했습니다</div>`
    console.error(e)
  } finally {
    clearTimeout(showPending)
  }
  if (isHome) setupIntro(true) // 인트로 모드 + 초기 스크롤 위치 지정
  else { document.body.classList.remove('intro-on'); window.scrollTo(0, 0) }
  if (isHome && pendingScroll) {
    // 다른 페이지에서 넘어온 경우입니다. 화면이 이미 통째로 새로 그려졌으니
    // 긴 거리를 애니메이션할 이유가 없고, 앵커처럼 바로 착지하는 편이 확실합니다.
    const target = pendingScroll
    pendingScroll = null
    scrollToSectionWhenReady(target, { smooth: false })
  }
  updateNavActive() // 내비 활성 표시 (홈은 스크롤 위치 기준)
  markLoadedImages() // 캐시된 이미지 즉시 표시
  // 페이지 전환 페이드인
  main.classList.remove('page-in')
  void main.offsetWidth // 애니메이션 재시작 트리거
  main.classList.add('page-in')
}
// 내비 활성 표시: 다른 페이지는 그 항목 고정, 홈은 스크롤이 컬렉션 섹션에 닿을 때만 켜짐(최상단=없음)
function updateNavActive() {
  const hash = location.hash || '#/'
  const isHome = hash === '#/' || hash === ''
  let key = ''
  if (isHome) {
    const col = document.querySelector('#collections')
    if (col) {
      const r = col.getBoundingClientRect()
      if (r.top < innerHeight * 0.55 && r.bottom > innerHeight * 0.15) key = '#collections'
    }
  } else if (hash.startsWith('#/photos')) key = '#/photos'
  else if (hash.startsWith('#/models') || /^#\/m\//.test(hash)) key = '#/models'
  else if (hash.startsWith('#/characters') || /^#\/ch\//.test(hash) || /^#\/s\//.test(hash)) key = '#/characters'
  else if (hash.startsWith('#/about')) key = '#/about'
  else if (/^#\/c\//.test(hash)) key = '#collections'
  document.querySelectorAll('.nav-links a').forEach((a) => {
    const k = a.dataset.scroll || a.getAttribute('href') || ''
    a.classList.toggle('active', k === key)
  })
}
window.addEventListener('scroll', () => { if ((location.hash || '#/') === '#/' || location.hash === '') updateNavActive() }, { passive: true })

window.addEventListener('hashchange', route)
route()
