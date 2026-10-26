# 기능 안내

어떤 일을 하고 싶은지 고른 뒤 **기능 설명**을 누르세요. 각 설명에서 사용 예시·화면 조작·적용 조건을 확인할 수 있습니다.

[프로젝트 첫 화면](README.md) · [선택 업데이트 ZIP 목록](updates/README.md) · [설치 안내](SETUP.md)

- **기본 포함**: 기준 배포본 `c1e54c3`에 들어 있는 기능입니다. 별도 설치·제거용 ZIP은 없습니다.
- **선택 업데이트**: 이미 배포한 사이트에 원하는 개선만 추가하는 패치입니다. 설명서와 Codex 요청문을 함께 제공합니다.

## 촬영·사진 정리

| 기능 | 할 수 있는 일 | 제공 형태 |
|---|---|---|
| [행사·개인 세션 정리](docs/features/collections.md) | 행사/개인 촬영 구분, 사람별 폴더, 관련 행사·장소 연결 | 기본 포함 |
| [사진 업로드·이미지 변환](docs/features/photo-upload.md) | 드래그 업로드, 웹 표시용 크기 변환, EXIF 읽기 | 기본 포함 |
| [사진 순서·대표 사진·공개 관리](docs/features/gallery-management.md) | 순서·대표 사진·이동·공개 상태 관리 | 기본 포함 |

## 정보 가져오기·모델 이름

| 기능 | 할 수 있는 일 | 제공 형태 | 적용 안내 |
|---|---|---|---|
| [트윗 정보 선택 가져오기](docs/features/tweet-import-select.md) | 닉네임·계정·장르·캐릭터·사진 중 필요한 것만 선택 | 선택 업데이트 | [설명서](updates/modules/tweet-import-select/README.md) · [Codex 요청문](updates/modules/tweet-import-select/CODEX.md) |
| [사람별 모델 표시 이름](docs/features/model-display-names.md) | 여러 모델의 계정별 이름과 촬영 묶음 제목을 구분 | 선택 업데이트 | [설명서](updates/modules/model-display-names/README.md) · [Codex 요청문](updates/modules/model-display-names/CODEX.md) |

트윗 선택 기능은 **사람별 모델 표시 이름 → 트윗 정보 선택 가져오기** 순서로 적용합니다.

## 방문자 화면·검색

| 기능 | 할 수 있는 일 | 제공 형태 | 적용 안내 |
|---|---|---|---|
| [갤러리 배치 개선](docs/features/gallery-layout.md) | 모바일 홀수·혼합 사진 배치, 데스크톱 중앙 정렬 | 선택 업데이트 | [설명서](updates/modules/gallery-layout/README.md) · [Codex 요청문](updates/modules/gallery-layout/CODEX.md) |
| [메인 사진 전환 안정화](docs/features/featured-photo-transition.md) | 사진 준비 후 설명과 함께 전환, 실패·연속 조작 처리 | 선택 업데이트 | [설명서](updates/modules/featured-photo-transition/README.md) · [Codex 요청문](updates/modules/featured-photo-transition/CODEX.md) |
| [모델·작품·캐릭터 탐색과 검색](docs/features/discovery.md) | 인물·작품별 탐색, 검색 별칭, 계정 변경 연결 | 기본 포함 | — |

## 보관·복구

| 기능 | 할 수 있는 일 | 제공 형태 |
|---|---|---|
| [휴지통·백업·복구](docs/features/backup-recovery.md) | 휴지통 복구, 사진·메타데이터 백업과 복원 | 기본 포함 |

## 처음 보는 분을 위한 선택 예시

- **트윗에서 계정과 캐릭터만 가져오고 싶다** → [트윗 정보 선택 가져오기](docs/features/tweet-import-select.md)
- **두 명이 함께한 사진에서 사람 이름을 따로 표시하고 싶다** → [사람별 모델 표시 이름](docs/features/model-display-names.md)
- **휴대폰에서 사진 3장·5장 배치를 정돈하고 싶다** → [갤러리 배치 개선](docs/features/gallery-layout.md)
- **메인 사진을 넘길 때 사진과 설명이 어긋난다** → [메인 사진 전환 안정화](docs/features/featured-photo-transition.md)

선택 업데이트는 [릴리스 페이지](https://github.com/EalZz/moments-kept-in-light/releases/tag/feature-updates-2026-10-26)의 기능별 ZIP으로 제공합니다. 이미 배포한 ZIP의 내용은 이 문서 정리 때문에 변경하지 않습니다. [적용·복구 안내](updates/APPLY.md)도 함께 확인하세요.
