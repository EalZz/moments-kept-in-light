# 사람별 모델 표시 이름

계정별 닉네임을 저장하고 행사·개인 세션·모델 목록에서 사람별 표시 이름을 일관되게 사용합니다.

- 기능 ID: `model-display-names` / 버전: `1.0.0`
- 검증 기준: 원본 저장소의 `c1e54c341b420e2307ae381faa7be895b4c7a265` (2026-09-19 배포 계열)
- 선행 기능: 없음
- DB 마이그레이션: 없음. 기존 JSON 메타데이터를 사용합니다.
- 개인 설정·사진·배포 정보: 업데이트에 포함하지 않습니다.
- 별도 수정된 버전: 아래 검사에 실패하면 전체 파일을 덮어쓰지 말고 `CODEX.md`로 차이를 비교하세요.

## 내려받기

[이 기능 ZIP](https://github.com/EalZz/moments-kept-in-light/releases/download/feature-updates-2026-10-26/model-display-names-1.0.0.zip) · [전체 기능 목록](../../README.md)

ZIP에는 패치·설명서·Codex 요청문·읽기 전용 검사기가 들어 있습니다. 자동 설치/배포 파일이 아닙니다.

## 적용 순서

1. ZIP을 프로젝트 바깥에 풀어 둡니다. 선행 기능이 있으면 먼저 적용합니다.
2. 본인 프로젝트를 복사해 백업하거나, 기존 수정사항을 별도 Git 커밋으로 보관합니다.
3. 본인 프로젝트 폴더에서 아래처럼 적용 가능 여부를 검사합니다. 경로는 ZIP을 푼 실제 위치로 바꿉니다.

```sh
node /ZIP을푼위치/model-display-names/check.mjs .
```

검사기는 프로젝트 파일·사진·Git 기록을 수정하지 않습니다. **검사 통과는 화면 동작 검증을 대신하지 않습니다.**

4. 검사에 통과했다면 같은 프로젝트 폴더에서 적용합니다.

```sh
git apply --check /ZIP을푼위치/model-display-names/update.patch
git apply /ZIP을푼위치/model-display-names/update.patch
```

5. 기존 설치 안내에 따라 의존성을 준비한 뒤 검사합니다.

```sh
npm test
```

6. 폴더/세션 편집에서 두 계정의 이름을 각각 입력하고, 저장·재조회 및 방문자 크레딧 표시를 확인하세요. 기존 등록 이름은 보존하세요.
7. 본인의 `wrangler.jsonc`, DB·버킷 바인딩을 확인하고 본인 Cloudflare 계정에 배포합니다. 원본 저장소의 운영 자원 이름으로 덮어쓰지 마세요. 배포 후 브라우저에서 새로고침하여 다시 확인합니다.

검사 결과가 '이미 적용됨'이면 재적용하지 않습니다. 충돌이 나면 `--reject`, 강제 덮어쓰기 또는 `git reset --hard`로 진행하지 말고 `CODEX.md`를 사용하세요.

## 변경 파일

- `public/admin.js`
- `public/admin.html`
- `src/worker.js`
- `public/app.js`
- `test/worker.test.js`

## 되돌리기

이 기능을 필요로 하는 후속 업데이트를 먼저 되돌립니다. 적용 후 파일을 추가 수정했다면 백업본과 비교하세요. 역방향 검사에 통과하는 경우에만 다음을 실행합니다.

```sh
git apply --reverse --check /ZIP을푼위치/model-display-names/update.patch
git apply --reverse /ZIP을푼위치/model-display-names/update.patch
```

사진·DB 데이터를 복구하는 명령이 아닙니다. 이전 코드로 되돌린 뒤 본인 사이트를 다시 배포해야 운영 화면에도 반영됩니다.
