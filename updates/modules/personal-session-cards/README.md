# 개인 세션 카드와 대표 사진 구도

개인 세션을 메인에서 가로형 카드로 보여줍니다. 관리자에서 원본 사진의 사용할 영역을 직접 고르고, 카드에 적용되는 블러와 텍스트를 기기별로 확인합니다.

- 기능 ID `personal-session-cards` · 버전 `1.0.0`
- 적용 검증 기준 `c1e54c3` 배포 계열
- 선행 기능 [사람별 모델 표시 이름](https://github.com/EalZz/moments-kept-in-light/blob/main/updates/modules/model-display-names/README.md) 1.0.0
- 기존 DB 스키마로 적용 가능

[ZIP 내려받기](https://github.com/EalZz/moments-kept-in-light/releases/download/feature-updates-2026-11-25/personal-session-cards-1.0.0.zip) · [사용 방법](https://github.com/EalZz/moments-kept-in-light/blob/main/docs/features/personal-session-cards.md) · [Codex 요청문](CODEX.md)

## 적용

1. 선행 기능을 적용하고 본인 프로젝트의 변경 사항을 복구할 수 있게 보관합니다.
2. ZIP을 프로젝트 바깥에 풀고, 프로젝트 폴더에서 아래 명령을 실행합니다. ZIP 경로는 실제 위치로 바꿉니다.

```sh
node /ZIP을푼위치/personal-session-cards/check.mjs .
git apply --check /ZIP을푼위치/personal-session-cards/update.patch
git apply /ZIP을푼위치/personal-session-cards/update.patch
npm test
node --test test/session-card.node.mjs
```

검사기가 충돌이나 선행 기능 누락을 보고하면 [Codex 요청문](CODEX.md)으로 대상 코드를 비교해 통합하세요.

3. 로컬에서 동작을 확인한 뒤 본인의 Cloudflare 설정으로 배포합니다.

두 비율의 미리보기, 구도 저장 후 다시 열기, 공개 카드 반영, 작품·캐릭터가 한 항목만 있을 때 빈 줄이 생기지 않는지 확인합니다.

## 되돌리기

의존하는 후속 패치를 먼저 되돌린 뒤, 역방향 검사에 통과하면 아래 명령을 실행합니다.

```sh
git apply --reverse --check /ZIP을푼위치/personal-session-cards/update.patch
git apply --reverse /ZIP을푼위치/personal-session-cards/update.patch
```

이 명령은 코드 변경을 되돌립니다. 사진과 DB에 저장된 내용은 별도로 관리합니다.
