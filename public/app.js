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
document.querySelectorAll('[data-scroll]').forEach((el) =>
  el.addEventListener('click', (ev) => {
    ev.preventDefault()
    const target = el.dataset.scroll
    const go = () => document.querySelector(target)?.scrollIntoView({ behavior: 'smooth' })
    if ((location.hash || '#/') !== '#/') {
      location.hash = '#/'
      setTimeout(go, 450) // 홈 렌더 후 스크롤
    } else go()
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
  if (isHome && document.querySelector('.hero') && !introSeenRecently()) {
    introActive = true
    window.scrollTo(0, 0)
    computeIntroY()
    document.body.classList.add('intro-on', 'intro-lock') // 펼쳐진 인트로
  }
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
      link.querySelector('.models').textContent = p.models.length ? p.models.map((h) => '@' + h).join(' · ') : ''
      link.querySelector('.character').textContent = p.character || ''
      info.classList.remove('swap') // 페이드인
    }, 420)
  }

  const show = (dir) => {
    if (busy) return
    busy = true
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
    back.src = '/img/' + p.key_large
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

  // 터치 스와이프 + 마우스 드래그 (탭/클릭과 구분: 수평 이동 50px 이상)
  let sx = 0, sy = 0, tracking = false, swiped = false
  const begin = (x, y) => { sx = x; sy = y; tracking = true }
  const finish = (x, y) => {
    if (!tracking) return
    tracking = false
    const dx = x - sx, dy = y - sy
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      swiped = true
      show(dx < 0 ? 1 : -1)
      startTimer() // 수동으로 넘기면 자동 타이머 리셋
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
  const keys = col.photos.map((p) => p.key_large)
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
function cardHtml(c) {
  return `
    <a class="card" href="#/c/${c.id}">
      <div class="cover" ${c.cover_w && c.cover_h ? `style="aspect-ratio:${c.cover_w}/${c.cover_h}"` : ''}>
        <img src="/img/${esc(c.cover_thumb)}" alt="${esc(c.title)}" loading="lazy" data-fade />
      </div>
      ${(c.preview_thumbs || []).length ? `<div class="strip">
        ${c.preview_thumbs.map((k, i) => {
          const extra = c.photo_count - 1 - c.preview_thumbs.length
          const isLast = i === c.preview_thumbs.length - 1
          return `<div class="s"><img src="/img/${esc(k)}" loading="lazy" data-fade />${isLast && extra > 0 ? `<span>+${extra}</span>` : ''}</div>`
        }).join('')}
      </div>` : ''}
      <div class="meta">
        <div class="info">${esc(c.date)}${c.date ? ' · ' : ''}${c.photo_count} photos</div>
        <div class="title">${esc(c.title)}</div>
      </div>
    </a>`
}

// 카드 masonry 배치: 읽는 순서(왼→오)를 지키며 가장 짧은 열에 순서대로 넣기
let homeCollections = null
function layoutCollections(force) {
  const wrap = document.querySelector('.collections')
  if (!wrap || !homeCollections) return
  const n = innerWidth <= 620 ? 1 : innerWidth <= 980 ? 2 : 3
  if (!force && +wrap.dataset.cols === n) return
  wrap.dataset.cols = n
  const heights = Array(n).fill(0)
  const colEls = Array.from({ length: n }, () => {
    const d = document.createElement('div')
    d.className = 'mcol'
    return d
  })
  for (const c of homeCollections) {
    const i = heights.indexOf(Math.min(...heights))
    colEls[i].insertAdjacentHTML('beforeend', cardHtml(c))
    // 카드 높이 추정 (열 폭 기준 비율): 커버 + 썸네일 스트립 + 텍스트
    const coverH = c.cover_w && c.cover_h ? c.cover_h / c.cover_w : 0.75
    heights[i] += coverH + ((c.preview_thumbs || []).length ? 0.36 : 0) + 0.28
  }
  wrap.replaceChildren(...colEls)
}
window.addEventListener('resize', () => layoutCollections(false))

async function renderHome() {
  const [cols, settings] = await Promise.all([api('/collections'), api('/settings')])
  const visible = cols.filter((c) => c.photo_count > 0)
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
      <div class="feature-img"><img src="/img/${esc(featured.cover_large)}" alt="${esc(featured.title)}" /></div>
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
      <div class="feature-img"><img src="/img/${esc(p.key_large)}" alt="${esc(p.title)}" /></div>
      <div class="feature-info">
        <div class="label">Gallery</div>
        <div class="name">${esc(p.title)}</div>
        <div class="date models">${p.models.length ? p.models.map((h) => '@' + esc(h)).join(' · ') : ''}</div>
        <div class="character">${esc(p.character || '')}</div>
      </div>
    </a>`
  }

  const grid = visible.length ? `
    <section id="collections">
      <div class="sec-kicker"><span>Collections</span><a class="n" href="#/photos">전체 사진 →</a></div>
      <div class="collections"></div>
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
  homeCollections = visible
  layoutCollections(true)
  if (featured && featured.cover_large) startFeatureRotation(featured.id, featured.cover_large)
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
      <div class="ph" data-i="${i}" style="flex-grow:${aspectOf(p).toFixed(4)}; aspect-ratio:${p.width || 3}/${p.height || 4}">
        <img src="/img/${esc(p.key_thumb)}" loading="lazy" data-fade />
      </div>`).join('')}${fill ? `<div class="jfill" style="flex-grow:${fill.toFixed(4)}"></div>` : ''}</div>`
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
    s.character = (s.meta && s.meta.character) || ''
    s.photos.forEach((p) => {
      if (s.handles.length) p._models = s.handles
      if (s.character) p._character = s.character
    })
  }
  // 라이트박스용 사진 목록: 표시 순서 그대로 하나로 이어붙임 (폴더가 달라져도 계속 넘어감)
  const flat = [...ungrouped, ...sections.flatMap((s) => s.photos)]
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
          `<a href="https://x.com/${esc(h)}" target="_blank" rel="noopener">@${esc(h)} ↗</a>`).join(' ')}${
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
      : `${ungrouped.length ? '<div class="jgrid"></div>' : ''}${sectionBlocks.join('')}`}`

  layoutJustifiedAll()

  main.querySelectorAll('.view-toggle button').forEach((b) =>
    b.addEventListener('click', () => {
      localStorage.setItem('pht-view', b.dataset.view)
      renderCollection(id)
    }))

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
  const box = document.createElement('div')
  box.className = 'lightbox'
  box.innerHTML = `
    <span class="count"></span>
    <img />
    <div class="exif"></div>
    <button class="nav-arrow prev" aria-label="이전">‹</button>
    <button class="nav-arrow next" aria-label="다음">›</button>
    <button class="close" aria-label="닫기">×</button>`
  document.body.appendChild(box)
  document.body.style.overflow = 'hidden'

  const show = () => {
    const p = current.photos[current.index]
    box.querySelector('img').src = '/img/' + p.key_large
    const exifEl = box.querySelector('.exif')
    exifEl.textContent = [p._event, exifLine(p)].filter(Boolean).join(' · ')
    for (const handle of p._models || []) {
      // 모델(코스어) 크레딧 링크 (여러 명 가능)
      if (exifEl.textContent || exifEl.querySelector('a')) exifEl.appendChild(document.createTextNode(' · '))
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
  const move = (d) => {
    current.index = (current.index + d + current.photos.length) % current.photos.length
    show()
  }
  const close = () => {
    document.removeEventListener('keydown', onKey)
    document.body.style.overflow = ''
    box.remove()
  }
  const onKey = (ev) => {
    if (ev.key === 'Escape') close()
    else if (ev.key === 'ArrowLeft') move(-1)
    else if (ev.key === 'ArrowRight') move(1)
  }
  document.addEventListener('keydown', onKey)
  box.querySelector('.prev').addEventListener('click', () => move(-1))
  box.querySelector('.next').addEventListener('click', () => move(1))
  box.querySelector('.close').addEventListener('click', close)
  box.addEventListener('click', (ev) => { if (ev.target === box) close() })

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
    photosMore.total = r.total
    layoutJustifiedAll()
  } finally {
    photosMore.loading = false
  }
})

// ---------- 모델 아카이브 ----------
async function renderModels() {
  const models = await api('/models')
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
      if (s.character) p._character = s.character
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
  try {
    if (m) await renderCollection(m[1], m[2] ? +m[2] : null)
    else if (hash === '#/photos') await renderPhotos()
    else if (hash === '#/models') await renderModels()
    else if (hash === '#/about') await renderAbout()
    else if (mm) await renderModel(mm[1])
    else await renderHome()
  } catch (e) {
    main.innerHTML = `<div class="empty">불러오지 못했습니다</div>`
    console.error(e)
  }
  if (isHome) setupIntro(true) // 인트로 모드 + 초기 스크롤 위치 지정
  else { document.body.classList.remove('intro-on'); window.scrollTo(0, 0) }
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
