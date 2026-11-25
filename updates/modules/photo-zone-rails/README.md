# Photo Zone과 가로 세션 카드

사진사존처럼 행사에서 모델·팀별로 진행한 촬영을 `Photo Zone`에 따로 모읍니다. 메인의 `Personal Sessions`와 `Photo Zone`은 각각 가로 카드 줄로 표시합니다.

- 기능 ID `photo-zone-rails` · 버전 `1.0.0`
- 적용 검증 기준 `c1e54c3` 배포 계열
- 선행 기능 [개인 세션 카드와 대표 사진 구도](https://github.com/EalZz/moments-kept-in-light/blob/main/updates/modules/personal-session-cards/README.md) 1.0.0
- 기존 DB 스키마로 적용 가능

[ZIP 내려받기](https://github.com/EalZz/moments-kept-in-light/releases/download/feature-updates-2026-11-25/photo-zone-rails-1.0.0.zip) · [사용 방법](https://github.com/EalZz/moments-kept-in-light/blob/main/docs/features/photo-zone-rails.md) · [Codex 요청문](CODEX.md)

## 적용

1. 선행 기능을 적용하고 본인 프로젝트의 변경 사항을 복구할 수 있게 보관합니다.
2. ZIP을 프로젝트 바깥에 풀고, 프로젝트 폴더에서 아래 명령을 실행합니다. ZIP 경로는 실제 위치로 바꿉니다.

```sh
node /ZIP을푼위치/photo-zone-rails/check.mjs .
git apply --check /ZIP을푼위치/photo-zone-rails/update.patch
git apply /ZIP을푼위치/photo-zone-rails/update.patch
npm test
node --test test/session-card.node.mjs test/session-rail.node.mjs
```

검사기가 충돌이나 선행 기능 누락을 보고하면 [Codex 요청문](CODEX.md)으로 대상 코드를 비교해 통합하세요.

3. 로컬에서 동작을 확인한 뒤 본인의 Cloudflare 설정으로 배포합니다.

카드가 한 화면에 들어가면 정지하고, 넘칠 때 마지막 카드가 첫 카드로 이어지는지 확인합니다. 공개 사진이 있는 Photo Zone 세션이 0건이면 그 섹션은 숨겨집니다.

## 되돌리기

의존하는 후속 패치를 먼저 되돌린 뒤, 역방향 검사에 통과하면 아래 명령을 실행합니다.

```sh
git apply --reverse --check /ZIP을푼위치/photo-zone-rails/update.patch
git apply --reverse /ZIP을푼위치/photo-zone-rails/update.patch
```

이 명령은 코드 변경을 되돌립니다. 사진과 DB에 저장된 내용은 별도로 관리합니다.
