# ADR-024: 오케스트레이터 작업은 한 번에 하나 — 겹친 요청은 거절하고 부른 쪽이 정한다

> 상태: 승인
> 결정일: 2026-09-28

## 맥락

오케스트레이터는 실행마다 상태를 쥔다(S-09).

- 원격을 본 시각: `observation.seenAt`. pull 을 시작한 시각이다(N-05, `beginRemoteObservation`).
- 이번 실행이 고른 새 경로: `claimedPaths`. pull 을 시작할 때 비운다.
- 자리를 마련하지 못한 폴더: `unpreparedFolders`.

두 실행이 겹치면 뒤 실행이 앞 실행의 것을 덮는다. 앞 pull 이 남은 레코드에 뒤 실행의 시작 시각을 적는다. 그 사이의 Notion
편집은 본 것이 되어 다음 pull 이 받지 않는다. 뒤 pull 이 선점 장부를 비우면 두 실행이 같은 새 경로를 골라 서로의 파일을
덮는다. 이 둘은 코드로 확인했고, 실제로 재현하지는 않았다.

한 오케스트레이터를 부르는 곳과 저마다의 가드(코드):

| 부르는 곳                                                 | 예전 가드                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| 플러그인 수동 push · pull · sync(명령 · 리본 · 사이드바)  | 없음 — 자동 주기 sync(같은 `sync()`)가 겹쳐 돌며 취소 신호를 덮어씀         |
| 플러그인 자동 주기 sync(`setInterval`)                    | 없음                                                                        |
| 플러그인 볼트 이벤트 sync(2초 디바운스)                   | 볼트 이벤트 sync · 충돌 해결만 봄 — 수동 sync 중에도 돔                     |
| 플러그인 충돌 해결 · 원격 상태 확인(사이드바 · 상태 명령) | 충돌 해결만 셋을 봄 · 상태 확인은 없음                                      |
| 플러그인 취소                                             | 신호만 보내고 잠금을 바로 풂 — 처리 중인 항목이 끝나기 전에 새 작업         |
| CLI `watch` 파일 변경 sync                                | 서비스 안에서만 줄을 섬                                                     |
| CLI `watch --interval` 주기 sync                          | 서비스 밖에서 `service.isSyncing()` 만 봄 — 그 뒤 온 파일 변경 sync 와 겹침 |
| 플러그인 내리기 · 설정 변경 · CLI 종료                    | 도는 sync 를 기다리지 않고 상태 DB 를 닫음                                  |

## 결정

1. **core 의 `SyncOrchestrator` 가 작업 하나만 받는다**(`OperationGate`). 도는 작업이 있으면 기다리게 하지 않고
   `SyncBusyError` 로 거절한다. 오류는 도는 작업과 거절한 작업을 싣고, 알림 문구는 화면 이름(「Pull」 「상태 확인」)을
   쓴다.
   - 잠그는 것: push · pull · sync · status · fetch · 충돌 해결(`resolveConflict` · `resolveAllConflicts` ·
     `clearStaleConflicts`). sync 는 안에서 pull · push 를 잠금 없이 부른다.
   - 잠그지 않는 것: `statusLocal` · 이름 변경 · 삭제 기록 · `listConflicts` · 원격 스냅샷 렌더 · 완전성 검사. 로컬만
     보거나 실행별 상태를 쓰지 않는다.
2. **무엇을 할지는 부른 쪽이 정한다.**
   - 플러그인 `SyncController` 가 작업을 한 줄에 세운다. 수동 · 자동 · 볼트 이벤트 sync, 충돌 해결, 원격 상태 확인이
     모두 들어간다.
     - 사용자가 부른 것은 무엇이 돌아 거절했는지 알린다.
     - 자동 주기는 조용히 건너뛴다.
     - 볼트 이벤트는 끝난 뒤 한 번 돈다.
     - 사이드바 새로고침은 로컬만 새로고친다.
   - CLI `watch` 는 주기 sync 도 `WatchSyncService` 에 요청한다(`requestFullSync`). 도는 sync 가 있으면 끝난 뒤
     한 번만 돈다.
3. **취소한 작업은 멈출 때까지 줄을 쥔다.** 처리 중인 항목은 끝까지 간다. 「취소됨」 은 멈춘 뒤에 알리고, 완료로 알리지
   않는다.
4. **닫기 전에 멈추고 기다린다.** 도는 작업을 취소하고 끝나기를 기다린 뒤 상태 DB 를 닫는다. 대상은 플러그인
   `shutdown()` · CLI `WatchSyncService.stop()` 이다. 묻던 충돌 창은 닫고, 남은 충돌은 묻지 않는다. 플러그인
   초기화는 차례로 돈다 — 설정 창이 글자마다 부른다.

## 선택지 — 겹친 요청

| 선택지                            | 판단                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 두지 않음(예전)                   | 실행별 상태를 서로 덮는다                                                                             |
| core 에서 줄 세우기(큐)           | 실볼트 pull 은 500초다. 그동안 주기 sync · 볼트 이벤트가 쌓이고, 사용자가 누른 것은 말없이 늦게 돈다  |
| 실행별 상태를 실행마다 따로 둠    | 겹쳐 돌 수는 있다. 같은 노트 · 같은 새 경로를 두 실행이 쓰는 것은 여전하다 — 볼트 · 상태 DB 가 하나다 |
| **core 는 거절 · 부른 쪽이 정함** | 겹침을 core 가 막고, 기다릴지 · 건너뛸지 · 알릴지는 부른 쪽의 맥락이 정한다 — **고른 것**             |

## 트레이드오프

- **프로세스 사이는 막지 않는다.** CLI `watch` 와 플러그인이 같은 볼트를 함께 돌리면 오케스트레이터가 둘이다. 둘은 같은
  상태 DB 파일(`.im-nobsidian/sync.db`)을 쓴다. 플러그인은 sql.js 메모리 사본을 5초마다 파일째 쓰고, CLI 는
  better-sqlite3 로 그 파일을 직접 연다. 함께 돌리면 서로의 기록을 덮을 수 있다 — 재지 않았다.
- 볼트 이벤트 sync 는 여전히 볼트 전체를 본다. 도는 작업 뒤 한 번 도는 것도 전체다. 바뀐 경로만 보는 것은 빠른 변경
  감지(Phase A)에서 한다.
- 충돌 해결이 쓴 병합 결과는 해결 뒤 볼트 이벤트 sync 를 한 번 부른다. 예전에는 무시했다. 푼 노트는 이미 올라가 있어 그
  sync 가 할 일은 없다.
- 상태 확인(`status`)은 취소 신호를 받지 않는다 — 내리는 중이면 끝나기를 기다린다.

## 영향

- 추가: `core/sync/operation-gate.ts`(`OperationGate` · `SyncBusyError` · `operationLabel`)
- 수정
  - `core/sync/orchestrator.ts`: 공개 메서드가 잠금을 거쳐 `execute*` 를 부른다.
  - `core/watcher/watch-sync-service.ts`: `requestFullSync` 추가. `stop()` 이 취소하고 기다린다. 콜백은 sync 범위를
    받는다(`"changes" | "full"`). `onSyncCancelled` 추가.
  - `cli/commands/watch.ts`
  - `obsidian-plugin/sync/sync-controller.ts`: `autoSync` · `shutdown` 추가.
  - `obsidian-plugin/main.ts`
- 공개 API(계약 변경)
  - 겹쳐 부른 오케스트레이터 작업은 `SyncBusyError` 로 거절된다. 예전에는 함께 돌았다.
  - `WatchSyncService.stop()` 은 도는 sync 가 멈출 때까지 돌아오지 않는다.
  - `WatchSyncOptions` 콜백에 둘째 인자(범위)가 붙는다.
- 상태 DB 스키마 · 설정: 변경 없음

## 검증

- 단위 · 통합
  - `tests/sync/operation-gate.test.ts`: 잠금 · 메모리 Notion 위 오케스트레이터
  - `tests/watcher/watch-sync-service.test.ts`
  - `cli/tests/commands/watch.test.ts`
  - `obsidian-plugin/tests/sync/sync-controller.test.ts`
  - `obsidian-plugin/tests/main.test.ts`
- 변이 · 결과 — `docs/06-devlog/journal/2026-09-28.md` 「작업 겹침 (S-09)」 절
