<div align="center">

<img src="public/og.png" alt="Moments Kept in Light" width="760" />

# Moments Kept in Light

**빛으로 남긴 순간들** — 행사·출사에서 담은 사진을 위한 미니멀 다크 포토 포트폴리오

브라우저에서 사진을 직접 올리고 관리하는 **웹 관리자**를 갖춘, Cloudflare 스택 기반 자체 제작 사이트입니다.

<br/>

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)](https://hono.dev/)
![D1](https://img.shields.io/badge/D1-SQLite-003B57?logo=sqlite&logoColor=white)
![R2](https://img.shields.io/badge/R2-Storage-F38020?logo=cloudflare&logoColor=white)
![JavaScript](https://img.shields.io/badge/Vanilla-JS-F7DF1E?logo=javascript&logoColor=black)

### 🔗 [**라이브 사이트 바로가기 →**](https://pht-pp.phtkanez.workers.dev)

</div>

---

## ✨ 주요 기능

- 🖼️ **다크 에디토리얼 갤러리** — 행사(컬렉션) 단위로 정리, 사람별 폴더에 모델 계정·캐릭터 크레딧 표시
- 👀 **3가지 보기 방식** — 컬렉션별 / 모델별 아카이브 / 전체 사진 스트림(무한 스크롤)
- 🎬 **시네마틱 인트로** — 스크롤·제스처로 접히고 펼쳐지는 히어로 애니메이션 (GPU 트랜스폼, 모바일 최적화)
- 🛠️ **웹 기반 관리자** (`/admin`, 비밀번호 보호)
  - 드래그&드롭 업로드 + **브라우저에서 자동 리사이징**(`OffscreenCanvas` → WebP) + EXIF 추출
  - **트윗 가져오기** — X(트위터) 게시물에서 사진을 바로 불러오고 모델/캐릭터 크레딧 자동 파싱
  - **그리드 콜라주 메이커** — 고른 사진을 정렬해 공유용 한 장 이미지로 합성
  - 드래그 정렬, 일괄 이동/삭제, 컬렉션 커버·메인 슬라이드 지정
- 📱 **반응형** — 데스크톱은 불규칙 justified 그리드, 모바일은 최적화된 레이아웃

## 🛠 기술 스택

| 영역 | 사용 기술 |
|------|-----------|
| 서버 | **Cloudflare Workers** + [Hono](https://hono.dev/) |
| DB | **D1** (SQLite) — 컬렉션·사진·폴더·모델 메타데이터 |
| 스토리지 | **R2** — 사진 원본 저장 |
| 프론트 | **Vanilla JS SPA** (해시 라우팅, 프레임워크 無) |
| 배포 | **Wrangler** |

## 📁 프로젝트 구조

```
src/worker.js      # Hono 백엔드: API, 인증, 이미지 프록시, OG 메타 주입
public/
  index.html       # SPA 셸
  app.js           # 라우터, 갤러리, 인트로 애니메이션
  admin.js         # 관리자 패널 (업로드 · 트윗 가져오기 · 그리드 메이커)
  style.css        # 다크 에디토리얼 테마
  config.js        # 사이트 이름 · 문구 (한 곳에서 관리)
wrangler.jsonc     # Workers / D1 / R2 바인딩
```

## 💻 로컬 개발

```bash
npm install
npx wrangler dev --port 8787
```

로컬 관리자 비밀번호는 `.dev.vars`(gitignore됨)에 설정합니다.

```
ADMIN_PASSWORD=your-dev-password
```

## 🚀 배포

```bash
npx wrangler deploy
```

프로덕션 비밀번호는 커밋하지 않고 Wrangler secret으로 관리합니다.

```bash
npx wrangler secret put ADMIN_PASSWORD
```

---

<div align="center">

📷 **사진 저작권은 촬영자에게 있습니다 — 사용 전 문의 부탁드려요.**
코드는 포트폴리오 참고용으로 공개합니다.

</div>
