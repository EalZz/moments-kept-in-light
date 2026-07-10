# 🚀 처음부터 따라 하는 설치 가이드

코딩을 몰라도 순서대로 따라 하면 **나만의 사진 포트폴리오 사이트**를 무료로 띄울 수 있어요.
전부 무료 요금제 안에서 됩니다. 예상 소요 시간 **30분~1시간**.

> 💡 Claude Code / Codex 같은 AI 도구를 쓴다면, 각 단계의 명령어를 그대로 붙여넣거나
> "이 폴더에서 ○○ 해줘"라고 부탁하면 돼요. (→ [부록 D](#부록-d-ai-도구-claude-codecodex-로-할-때))

---

## 📋 큰 그림 (뭘 하게 되나)

1. 계정 2개 만들기 — **GitHub**(코드 저장), **Cloudflare**(사이트 호스팅)
2. 컴퓨터에 도구 2개 깔기 — **Node.js**, **Git**
3. 코드 내려받기
4. Cloudflare에 **데이터베이스(D1)** 와 **사진 저장소(R2)** 만들기
5. 설정 파일에 이름/주소 채우기
6. 배포 → 나만의 주소 `https://내이름.내계정.workers.dev` 완성
7. `/admin`에서 사진 업로드

---

## 1단계 · 계정 만들기

- **GitHub** — https://github.com/signup (무료)
- **Cloudflare** — https://dash.cloudflare.com/sign-up (무료)

둘 다 이메일 인증까지 마쳐 두세요.

---

## 2단계 · 도구 설치 (Node.js, Git)

### Node.js (필수)
- https://nodejs.org 접속 → **LTS** 버전 다운로드 → 설치
- 설치 후 확인: **터미널**(맥: `터미널`, 윈도우: `PowerShell`)을 열고
  ```bash
  node -v
  ```
  `v20.x` 같은 숫자가 나오면 OK.

### Git (필수)
- 맥: 터미널에 `git --version` 입력 → 없으면 설치창이 뜸(따라서 설치)
- 윈도우: https://git-scm.com/download/win 에서 설치

> ℹ️ **Wrangler**(Cloudflare 배포 도구)는 따로 안 깔아도 돼요.
> 아래에서 `npx wrangler ...` 형태로 자동 실행됩니다.

---

## 3단계 · 코드 내려받기

이 저장소를 **내 GitHub로 복사(Fork)** 한 뒤 내 컴퓨터로 가져옵니다.

1. 원본 저장소 페이지에서 오른쪽 위 **`Fork`** 클릭 → 내 계정에 복사본이 생김
2. 내 Fork 페이지에서 초록색 **`Code`** 버튼 → HTTPS 주소 복사
3. 터미널에서 원하는 폴더로 이동 후 내려받기:
   ```bash
   cd ~/Documents
   git clone https://github.com/<내아이디>/<저장소이름>.git
   cd <저장소이름>
   ```
4. 필요한 라이브러리 설치:
   ```bash
   npm install
   ```

---

## 4단계 · Cloudflare 로그인

```bash
npx wrangler login
```
→ 브라우저가 열리면 **Allow(허용)** 클릭. "Successfully logged in" 나오면 성공.

---

## 5단계 · 데이터베이스(D1) & 사진 저장소(R2) 만들기

### D1 (사진 정보를 담는 DB)
```bash
npx wrangler d1 create my-portfolio-db
```
→ 출력에 나오는 **`database_id = "xxxxxxxx-..."`** 를 복사해 두세요. (6단계에서 씀)

### R2 (사진 파일 저장소)
1. 먼저 대시보드에서 **R2를 한 번 켜야 해요**: https://dash.cloudflare.com → 왼쪽 **R2** → 안내에 따라 활성화
   (무료 요금제라도 카드 등록을 요구할 수 있는데, **무료 한도 안에서는 청구되지 않아요**.)
2. 버킷 생성:
   ```bash
   npx wrangler r2 bucket create my-portfolio-photos
   ```

> 이름(`my-portfolio-db`, `my-portfolio-photos`)은 원하는 대로 바꿔도 되고,
> 아래 설정 파일에 **똑같이** 적어주기만 하면 됩니다.

---

## 6단계 · 설정 파일 수정 (`wrangler.jsonc`)

프로젝트 폴더의 **`wrangler.jsonc`** 를 텍스트 편집기로 열고 3곳을 내 것으로 바꿉니다:

```jsonc
{
  "name": "my-portfolio",            // ← ✅ 사이트 주소 앞부분이 됨 (영문/숫자/하이픈)
  ...
  "d1_databases": [
    {
      "binding": "DB",               // ← ❌ 절대 바꾸지 마세요
      "database_name": "my-portfolio-db",                 // ← ✅ 5단계에서 만든 D1 이름
      "database_id": "여기에-복사한-database_id-붙여넣기"   // ← ✅ 5단계 출력값
    }
  ],
  "r2_buckets": [
    {
      "binding": "PHOTOS",           // ← ❌ 절대 바꾸지 마세요
      "bucket_name": "my-portfolio-photos"                // ← ✅ 5단계에서 만든 R2 이름
    }
  ]
}
```

⚠️ **`binding`(DB, PHOTOS, ASSETS)은 코드가 쓰는 이름이라 절대 바꾸면 안 돼요.**
바꾸는 건 `name`, `database_name`, `database_id`, `bucket_name` 네 개뿐입니다.

---

## 7단계 · 관리자 비밀번호 설정

사진 올리는 `/admin` 페이지에 로그인할 비밀번호예요.

**배포용(실제 사이트):**
```bash
npx wrangler secret put ADMIN_PASSWORD
```
→ 원하는 비밀번호를 입력(화면엔 안 보임) 후 Enter.

**로컬 테스트용(선택):** 프로젝트 폴더에 `.dev.vars` 파일을 만들고 한 줄 적기:
```
ADMIN_PASSWORD=아무거나-테스트비번
```
(이 파일은 `.gitignore`에 있어서 GitHub에 안 올라가요.)

---

## 8단계 · 배포하기 🚀

```bash
# 데이터베이스 구조 적용
npx wrangler d1 migrations apply DB --remote

# 코드 배포
npx wrangler deploy
```

- **처음 배포라면** "workers.dev 서브도메인을 정하라"는 안내가 나와요.
  원하는 계정 이름(예: `mynickname`)을 정하면, 앞으로 모든 사이트 주소가
  `...mynickname.workers.dev`가 됩니다. (한 번 정하면 계정 전체에 적용)
- 성공하면 마지막에 주소가 떠요:
  ```
  https://my-portfolio.mynickname.workers.dev
  ```
  이게 **내 사이트 주소**예요! 🎉

---

## 9단계 · 사진 올리기

1. `내주소/#/` 로 접속 → 사이트 확인
2. `내주소/admin` 접속 → 7단계 비밀번호로 로그인
3. **새 컬렉션** 만들기(행사 단위) → 드래그&드롭으로 사진 업로드
   - 트윗 URL 붙여넣기로 X(트위터) 사진도 바로 가져올 수 있어요
4. 사진 정리와 대표 지정이 끝나면 **공개하기** 버튼을 누릅니다.
5. 삭제한 사진과 컬렉션은 관리자 화면의 **휴지통**에서 복구하거나 영구 삭제할 수 있습니다.
6. 중요한 수정 전에는 관리자 화면의 **백업(JSON)** 버튼으로 메타데이터를 내려받아 보관하세요.

---

## 10단계 · 수정하고 다시 올리기 (평소 작업 흐름)

파일(문구·색·이미지 등)을 고친 뒤:

```bash
# 실제 사이트에 반영
npx wrangler deploy

# GitHub에도 저장(백업)
git add -A
git commit -m "수정 내용 한 줄 설명"
git push
```

> 사진 추가/삭제는 코드 배포 없이 `/admin`에서 바로 하면 됩니다.
> `wrangler deploy`는 **디자인·문구·기능(코드)** 을 바꿨을 때만 하면 돼요.

---

# 📎 부록

## 부록 A · 닉네임 · 문구 바꾸기

**`public/config.js`** 한 파일에서 사이트 이름과 문구가 전부 관리돼요.

```js
window.SITE = {
  name: 'KANEZ',                         // 사이트 이름(로고)
  headline: 'Moments kept\nin light.',   // 메인 큰 문구 (\n = 줄바꿈)
  intro: 'The moments we met, frame by frame.', // 한 줄 소개
  twitter: 'pht_KANEZ',                  // X 핸들 (없으면 '' 로 비우기)
  email: 'clapa0211@gmail.com',          // 연락 이메일
  about: {
    intro: [ '소개 문단 1', '소개 문단 2' ],   // About 페이지 소개
    gear: [ 'Camera · ...', 'Lens · ...' ],   // 장비 목록 (없으면 [])
    note: '촬영 문의 안내 한 줄',
  },
}
```

바꾼 뒤 `npx wrangler deploy` 하면 반영돼요.
(About 내용은 `/admin`의 "About 편집"에서 웹으로도 바꿀 수 있어요.)

## 부록 B · 색상 · 디자인 바꾸기

**`public/style.css`** 맨 위 `:root` 부분의 색 변수만 바꿔도 분위기가 확 달라져요.

```css
:root {
  --bg: #0b0b0d;        /* 배경색 */
  --fg: #ececea;        /* 기본 글자색 */
  --fg-dim: #9c9c9f;    /* 흐린 글자색 */
  --accent: #b8a98c;    /* 포인트 색 */
  --font-display: "Cormorant Garamond", "Noto Serif KR", serif;  /* 제목 폰트 */
}
```

## 부록 C · 인트로 배경 / 미리보기 이미지 바꾸기

`public/` 폴더의 이미지 파일을 **같은 이름으로** 교체하면 돼요:

| 파일 | 용도 | 권장 비율 |
|------|------|-----------|
| `gear.jpg` | 데스크톱 인트로 배경 | 가로 (16:9 정도) |
| `gear-mobile.jpg` | 모바일 인트로 배경 | 세로 (9:19.5 정도, 폰 화면) |
| `og.png` | 링크 공유 미리보기 카드 | 1200×630 |
| `favicon.svg` | 브라우저 탭 아이콘 | 정사각형 |

교체 후 `npx wrangler deploy`.
(위치·밝기 미세조정은 `style.css`의 `.hero-bg` 부분 — 어려우면 AI 도구에게 부탁하세요.)

## 부록 D · AI 도구 (Claude Code/Codex) 로 할 때

프로젝트 폴더를 도구에서 연 뒤, 이런 식으로 부탁하면 돼요:

- "wrangler.jsonc의 name을 `my-portfolio`로 바꾸고 배포해줘"
- "config.js에서 사이트 이름을 `○○`로, 헤드라인을 `○○`로 바꿔줘"
- "style.css 배경색을 좀 더 진한 남색으로 바꿔줘"
- "gear-mobile.jpg를 방금 넣은 새 사진으로 교체하고, 잘리지 않게 위치 맞춰서 배포해줘"
- "지금까지 수정한 거 git으로 커밋하고 push해줘"

> 처음 1회 인증(`wrangler login`, GitHub 로그인)은 브라우저가 필요해서
> 사람이 직접 해주는 게 확실해요. 그 뒤부터는 도구가 알아서 해줍니다.

## 부록 E · 자주 나오는 문제

| 증상 | 해결 |
|------|------|
| `wrangler: command not found` | `npx wrangler ...` 처럼 앞에 `npx` 붙이기 |
| R2 버킷 생성 오류 | 대시보드에서 **R2 활성화** 먼저 (5단계) |
| `/admin` 로그인 안 됨 | 7단계 `wrangler secret put ADMIN_PASSWORD` 했는지 확인 |
| 사진 업로드 실패 | `wrangler.jsonc`의 `bucket_name`이 실제 R2 이름과 같은지 확인 |
| 주소가 이상함 | `wrangler.jsonc`의 `name`이 주소 앞부분이 됨 → 바꾸고 재배포 |
| `git push`가 인증 요구 | GitHub 토큰 또는 SSH 키 설정 필요 (검색: "GitHub SSH 키 등록") |

---

막히면 이 파일의 해당 단계 번호와 함께 물어보면 돼요. 즐겁게 만들어 보세요! 📷
