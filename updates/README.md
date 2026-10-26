# 필요한 기능만 업데이트하기

이 페이지는 이미 Moments Kept in Light를 배포한 분을 위한 **선택 업데이트 목록**입니다.

원하는 기능의 설명과 ZIP만 받으세요. ZIP 안의 `CODEX.md` 요청문을 본인 프로젝트를 연 Codex에 붙여 넣으면 적용을 맡길 수 있습니다. 코드가 달라 자동 적용이 어려운 경우에도 변경 부분을 비교하는 자료로 사용할 수 있습니다.

[기능별 ZIP 내려받기](https://github.com/EalZz/moments-kept-in-light/releases/tag/feature-updates-2026-10-26) · [처음 설치하기](../SETUP.md) · [적용·복구 안내](APPLY.md)

## 선택 업데이트

| 필요한 기능 | 설명 | 먼저 필요한 기능 | 다운로드 |
|---|---|---|---|
| [사람별 모델 표시 이름](modules/model-display-names/README.md) | 여러 모델의 이름을 계정별로 저장하고 표시 | 없음 | [ZIP](https://github.com/EalZz/moments-kept-in-light/releases/download/feature-updates-2026-10-26/model-display-names-1.0.0.zip) |
| [트윗 정보 선택 가져오기](modules/tweet-import-select/README.md) | 가져올 정보 확인·선택, 사진 제외 가능 | 사람별 모델 표시 이름 | [ZIP](https://github.com/EalZz/moments-kept-in-light/releases/download/feature-updates-2026-10-26/tweet-import-select-1.0.0.zip) |
| [갤러리 배치 개선](modules/gallery-layout/README.md) | 모바일 홀수 사진·가로세로 혼합 배치, PC 중앙 정렬 | 없음 | [ZIP](https://github.com/EalZz/moments-kept-in-light/releases/download/feature-updates-2026-10-26/gallery-layout-1.0.0.zip) |
| [메인 사진 전환 안정화](modules/featured-photo-transition/README.md) | 다음 사진 준비 후 전환, 실패·연속 조작 처리 | 없음 | [ZIP](https://github.com/EalZz/moments-kept-in-light/releases/download/feature-updates-2026-10-26/featured-photo-transition-1.0.0.zip) |

트윗 선택 기능만 필요하다면 **표시 이름 → 트윗 선택** 순서로 두 묶음을 적용합니다. 갤러리나 메인 사진 전환은 선택하지 않아도 됩니다.

## 어떤 버전에서 쓸 수 있나요?

- 네 묶음은 원본 저장소의 `c1e54c3`(2026-09-19) 상태에서 적용·테스트했습니다. 트윗 묶음은 선행 기능 적용 후 검증했습니다.
- 다른 버전이나 개인 수정이 있으면 포함된 검사기로 먼저 확인하세요. 검사 실패는 강제 덮어쓰기를 뜻하지 않습니다. `CODEX.md`로 차이를 비교해 적용하세요.
- 여러 업데이트가 같은 파일을 수정할 수 있습니다. 개별 적용과 네 묶음의 결합을 검증했지만 임의의 모든 사용자 수정본까지 호환을 보장하지는 않습니다.
- 원본 `main`의 실행 코드는 기존 기준을 유지합니다. 이 배포에서 루트 실행 코드가 최신 운영 사이트와 자동으로 같아지는 것은 아닙니다. 기능 업데이트는 선택해서 적용하세요.

## 이미 기본 제공되는 기능

아래 기능은 기준 배포본에 포함되어 있습니다. 이번 릴리스에서 별도 설치·제거 패키지로 만들지는 않았습니다.

| 기능 | 기준 배포본에서의 상태 |
|---|---|
| 행사·개인 세션과 관련 행사 연결 | 기본 포함 |
| 드래그 업로드·이미지 크기 변환·EXIF | 기본 포함 |
| 모델·작품·캐릭터 탐색과 검색 | 기본 포함 |
| 대표 사진·사진 순서·공개 상태 관리 | 기본 포함 |
| 휴지통·복구·D1/R2 백업 | 기본 포함 |

이 업데이트들은 플러그인 자동 설치 시스템이 아니라, 기능별로 분리해 검증한 코드 변경 묶음입니다. 사진·컬렉션·계정·비밀번호·도메인·Worker/DB/버킷 설정을 배포하지 않습니다.
