# 현재 진행 상황

> 마지막 업데이트: 2026-05-13
> 버전: v0.1.0 (npm 배포 완료)

## 전체 상태

**v0.1.0 공개 릴리스 완료.** npm에 배포되어 `npm install -g im-nobsidian`으로 설치 가능.

| 항목                     | 상태                                            |
| ------------------------ | ----------------------------------------------- |
| npm `@im-nobsidian/core` | v0.1.0 published                                |
| npm `im-nobsidian` (CLI) | v0.1.0 published                                |
| GitHub Release           | v0.1.0 tagged                                   |
| Obsidian Plugin          | v0.5.0 예정 (better-sqlite3 → sql.js 전환 필요) |

## Phase 진행률

| Phase   | 설명                 | 상태    | 진행률 |
| ------- | -------------------- | ------- | ------ |
| Phase 1 | 기획 & 리서치        | ✅ 완료 | 100%   |
| Phase 2 | 아키텍처 설계        | ✅ 완료 | 100%   |
| Phase 3 | 프로젝트 초기화      | ✅ 완료 | 100%   |
| Phase 4 | 코어 변환 엔진       | ✅ 완료 | 100%   |
| Phase 5 | 동기화 엔진          | ✅ 완료 | 100%   |
| Phase 6 | CLI                  | ✅ 완료 | 100%   |
| Phase 7 | Obsidian 플러그인    | ⏸ 보류  | 90%    |
| Phase 8 | 테스트 & 안정화      | ✅ 완료 | 100%   |
| Phase 9 | 배포 & 오픈소스 공개 | ✅ 완료 | 100%   |

## 테스트 현황

- **단위/통합 테스트**: 355개 통과 (31 파일)
- **E2E 테스트**: 11개 통과 (실제 Notion API)
- **라운드트립 테스트**: 10개 픽스처
- **CLI 테스트**: 30개 (6 파일)

## CLI 명령어

| 명령            | 상태 | 비고                               |
| --------------- | ---- | ---------------------------------- |
| `nobsi init`    | ✅   | 대화형 + `--non-interactive`       |
| `nobsi push`    | ✅   | `--dry-run`, `--path`, 진행률 표시 |
| `nobsi pull`    | ✅   | 원격 변경 감지 + 변환 + 쓰기       |
| `nobsi sync`    | ✅   | pull → push 순차 실행              |
| `nobsi status`  | ✅   | 변경/충돌 표시                     |
| `nobsi diff`    | ✅   | 변경사항 상세 출력                 |
| `nobsi resolve` | ✅   | 대화형 + `--strategy`              |
| `nobsi watch`   | ✅   | chokidar + debounce 자동 동기화    |

## 알려진 제한사항

| 제한              | 원인                                     | 상태                   |
| ----------------- | ---------------------------------------- | ---------------------- |
| 이미지 Push       | Notion API에 파일 업로드 엔드포인트 없음 | 플레이스홀더로 보존    |
| Notion 전용 블록  | API가 unsupported 반환                   | 콜아웃 플레이스홀더    |
| 위키링크 Push     | Notion 페이지 멘션 매핑 미구현           | Bold 텍스트로 변환     |
| Obsidian 플러그인 | better-sqlite3 + Electron 호환 불가      | v0.5.0에서 sql.js 전환 |

## 다음 목표 (v0.1.1)

1. 사용자 테스트 피드백 반영
2. 위키링크 → Notion 페이지 멘션 링킹
3. 에러 메시지 개선
