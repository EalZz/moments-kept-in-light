# 세션 카드 기본 테두리 숨기기

개인 세션과 Photo Zone 카드의 기본 테두리를 숨깁니다. 마우스를 올리거나 키보드로 포커스하면 얇은 회색 선을 표시합니다. 관리자 카드 미리보기에도 기본 모양이 반영됩니다.

- 버전 `1.0.0`
- 선행 기능 [개인 세션 카드와 대표 사진 구도](https://github.com/EalZz/moments-kept-in-light/blob/main/updates/modules/personal-session-cards/README.md)
- 변경 파일 `public/style.css`

[ZIP 다운로드](https://github.com/EalZz/moments-kept-in-light/releases/download/feature-updates-2026-11-25-2/session-card-border-1.0.0.zip) · [Codex 요청문](CODEX.md)

## 적용

1. 선행 기능을 적용합니다. ZIP을 프로젝트 바깥에 풀고 기존 CSS를 복구할 수 있게 보관합니다.
2. 프로젝트 폴더에서 패치 적용 가능 여부를 확인하고 적용합니다.

```sh
node /ZIP을푼위치/session-card-border/check.mjs .
git apply --check /ZIP을푼위치/session-card-border/update.patch
git apply /ZIP을푼위치/session-card-border/update.patch
```

3. 기본 카드, 마우스를 올린 카드, 키보드 포커스, 관리자 미리보기를 확인한 뒤 본인의 Cloudflare 설정으로 배포합니다. 기존 DB 스키마로 적용할 수 있습니다.

## 되돌리기

```sh
git apply --reverse --check /ZIP을푼위치/session-card-border/update.patch
git apply --reverse /ZIP을푼위치/session-card-border/update.patch
```
