# 메인 사진 전환 안정화

다음 사진의 로딩·디코딩이 끝난 뒤 사진과 설명을 함께 전환합니다. 연속 조작·로딩 실패·시간 초과 시 이전 사진이 다시 끼어드는 현상을 방지합니다.

- 기능 ID: `featured-photo-transition` / 버전: `1.0.0`
- 검증 기준: 원본 저장소의 `c1e54c341b420e2307ae381faa7be895b4c7a265` (2026-09-19 배포 계열)
- 선행 기능: 없음
- DB 마이그레이션: 없음. 기존 JSON 메타데이터를 사용합니다.
- 개인 설정·사진·배포 정보: 업데이트에 포함하지 않습니다.
- 별도 수정된 버전: 아래 검사에 실패하면 전체 파일을 덮어쓰지 말고 `CODEX.md`로 차이를 비교하세요.

## 내려받기

[이 기능 ZIP](https://github.com/EalZz/moments-kept-in-light/releases/download/feature-updates-2026-10-26/featured-photo-transition-1.0.0.zip) · [전체 기능 목록](../../README.md)

ZIP에는 패치·설명서·Codex 요청문·읽기 전용 검사기가 들어 있습니다. 자동 설치/배포 파일이 아닙니다.

## 적용 순서

1. ZIP을 프로젝트 바깥에 풀어 둡니다. 선행 기능이 있으면 먼저 적용합니다.
2. 본인 프로젝트를 복사해 백업하거나, 기존 수정사항을 별도 Git 커밋으로 보관합니다.
3. 본인 프로젝트 폴더에서 아래처럼 적용 가능 여부를 검사합니다. 경로는 ZIP을 푼 실제 위치로 바꿉니다.

```sh
node /ZIP을푼위치/featured-photo-transition/check.mjs .
```

검사기는 프로젝트 파일·사진·Git 기록을 수정하지 않습니다. **검사 통과는 화면 동작 검증을 대신하지 않습니다.**

4. 검사에 통과했다면 같은 프로젝트 폴더에서 적용합니다.

```sh
git apply --check /ZIP을푼위치/featured-photo-transition/update.patch
git apply /ZIP을푼위치/featured-photo-transition/update.patch
```

5. 기존 설치 안내에 따라 의존성을 준비한 뒤 검사합니다.

```sh
node --test test/feature-transition.node.mjs
```

6. 느린 네트워크에서 연속 넘김, 이미지 실패, 자동 넘김 및 홈 이탈을 확인하세요. 기존 갤러리 디자인을 유지하는 전환 동작 업데이트이며 블러 배경/새 레이아웃은 포함하지 않습니다.
7. 본인의 `wrangler.jsonc`, DB·버킷 바인딩을 확인하고 본인 Cloudflare 계정에 배포합니다. 원본 저장소의 운영 자원 이름으로 덮어쓰지 마세요. 배포 후 브라우저에서 새로고침하여 다시 확인합니다.

검사 결과가 '이미 적용됨'이면 재적용하지 않습니다. 충돌이 나면 `--reject`, 강제 덮어쓰기 또는 `git reset --hard`로 진행하지 말고 `CODEX.md`를 사용하세요.

## 변경 파일

- `public/app.js`
- `test/feature-transition.node.mjs`

## 되돌리기

이 기능을 필요로 하는 후속 업데이트를 먼저 되돌립니다. 적용 후 파일을 추가 수정했다면 백업본과 비교하세요. 역방향 검사에 통과하는 경우에만 다음을 실행합니다.

```sh
git apply --reverse --check /ZIP을푼위치/featured-photo-transition/update.patch
git apply --reverse /ZIP을푼위치/featured-photo-transition/update.patch
```

사진·DB 데이터를 복구하는 명령이 아닙니다. 이전 코드로 되돌린 뒤 본인 사이트를 다시 배포해야 운영 화면에도 반영됩니다.
