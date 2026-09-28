# ADR-028: 동기화 엔진은 일마다 모듈로 나누고, 오케스트레이터는 순서와 잠금만 맡는다

> 상태: 승인
> 결정일: 2026-09-28

## 맥락

`core/sync/orchestrator.ts` 는 5,791줄이었다(`487614b`). 한 클래스(`SyncOrchestrator`)가 메서드 137개로 원격 변경
감지 · 원격이 바뀌었는지 판정 · 페이지 받기 · 올리기 · 폴더의 Notion 자리 · 로컬 변경 계획 · 충돌 해소 · 변경 비교 ·
중단 복구 · DB 자동 발견을 모두 했다.

- **실행마다 바뀌는 상태가 한 클래스의 필드에 흩어져 있었다.** 원격을 본 시각(N-05) · 이번 pull 이 고른 새 경로 ·
  받은 첨부 수 · 준비하지 못한 폴더 · 자식을 가진 페이지 집합 · 인라인 DB 참조가 모두 `this` 에 있었다. 어느 메서드가
  어느 상태를 바꾸는지 보려면 파일 전체를 읽어야 했다.
- **변경이 한 파일에 몰렸다.** v0.3.2 뒤 커밋 200개 가운데 33개가 이 파일을 고쳤다. 결함 하나를 고칠 때도 다른 일의
  코드 사이를 지나야 했다.
- 오케스트레이터가 그 일들을 «어떤 순서로» 부르는지(pull 의 단계, push 의 순서)가 수천 줄의 본문 사이에 묻혀 있었다.

## 결정

1. **일 하나에 모듈 하나.** 오케스트레이터가 하던 일을 아래 모듈로 옮겼다. 실행별 상태는 그 상태를 쓰는 모듈이
   쥔다.

   | 모듈                                              | 맡는 일                                                                            | 실행마다 쥐는 상태                       |
   | ------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
   | `orchestrator.ts` · `SyncOrchestrator`            | 공개 API · push / pull / sync / status 의 순서 · 작업 잠금(S-09)                   | —                                        |
   | `run-observation.ts` · `RunObservation`           | 이번 실행이 원격을 보는 기준(N-05) — 시작할 때 정하고 판정 · 기록이 같은 값을 쓴다 | 본 시각 · 봇 id                          |
   | `remote-detector.ts` · `RemoteDetector`           | 원격 변경 감지 — 전체 대조 · 증분(ADR-027)                                         | 자식을 가진 페이지 집합                  |
   | `remote-drift.ts` · `RemoteDriftChecker`          | 지난번 본 뒤로 원격이 바뀌었나(N-05) — 덮어쓰기 · 지우기 · 변경을 보이기 전에      | —                                        |
   | `page-puller.ts` · `PagePuller`                   | 원격 페이지 받기 — 새로 생긴 · 바뀐 · 지운 페이지, 충돌의 원격 렌더                | 이번 pull 이 고른 새 경로 · 받은 첨부 수 |
   | `pull-planner.ts` · `PullPlanner`                 | pull 할 것을 세기만 한다(dry-run) — 실제 pull 과 같은 규칙                         | —                                        |
   | `notion-link-pass.ts`                             | pull 이 쓴 노트의 Notion 링크를 볼트 링크로(후처리)                                | —                                        |
   | `database-discovery.ts` · `DatabaseDiscovery`     | 페이지 안의 DB 를 찾아 등록하고 받는다                                             | 인라인 DB 참조                           |
   | `local-planner.ts` · `LocalPlanner`               | 이번 실행의 로컬 변경 — 옮긴 노트 · 폴더 짝짓기(S-11)                              | —                                        |
   | `folder-placement.ts` · `FolderPlacement`         | 볼트 폴더의 Notion 자리 — 새 · 옮긴 노트의 부모, 폴더 페이지(S-04 · S-11 · S-15)   | 준비하지 못한 폴더                       |
   | `page-pusher.ts` · `PagePusher`                   | 로컬 변경 올리기 — 새 노트 · 고친 노트 · 옮김 · 지움, 충돌 해소 결과               | —                                        |
   | `conflict-workflow.ts` · `ConflictWorkflow`       | 충돌 목록 · 해소 · Notion 전파(I8 · N-06)                                          | —                                        |
   | `change-inspector.ts` · `ChangeInspector`         | 변경 하나를 견주고(Git 의 `diff`) 로컬 변경을 되돌린다(Git 의 `restore`)           | —                                        |
   | `interrupted-sync.ts` · `InterruptedSyncRecovery` | 중단된 실행의 정리 · 앞선 생성이 남긴 고아 페이지 입양(I12 · S-07)                 | —                                        |

   함수만 있는 도우미: `parent-mode.ts`(DB 모드 판정) · `notion-parent.ts`(부모 페이지 해소) ·
   `discovered-databases.ts`(발견한 DB 메타) · `missing-local-files.ts`(볼트에서 사라진 추적 파일) ·
   `note-title.ts`(제목 · 별칭).

2. **오케스트레이터는 순서와 잠금만 맡는다.** pull · push 가 어떤 단계를 어떤 순서로 밟는지는 `executePull` ·
   `executePush` 에서 읽는다 — 단계의 본문은 모듈에 있다. 작업 잠금(`OperationGate`, ADR-024)은 오케스트레이터에만
   있다. 볼트 · 상태 DB · 원격을 바꾸는 공개 메서드가 잠근 뒤 모듈을 부른다(`resolveConflict` →
   `ConflictWorkflow.resolveConflict`). 모듈은 잠그지 않는다. 충돌 해소가 올리기를 부를 때처럼 모듈이 모듈을 부르는
   것은 이미 잠근 실행 안이다.

3. **협력 객체는 오케스트레이터의 생성자에서 한 번 만들어 생성자 인자로 넘긴다** — 이 레포가 `DatabaseSyncer` ·
   `ImageHandler` 에 쓰던 방식이다. 모두 같은 인스턴스를 쓴다: `RunObservation` 하나를 감지 · 판정 · 받기 · 올리기 ·
   폴더 배치 · 충돌이 함께 본다. 실행별 상태를 가진 객체가 둘이 되면 두 기준이 갈린다.

4. **의존은 한 방향이다.** 값으로 서로를 가져오는 순환은 없다. `folder-placement` ↔ `local-planner` 는 타입만 서로
   가져온다.

   ```mermaid
   flowchart TD
       Conflicts["ConflictWorkflow"]
       Inspector["ChangeInspector"]
       Puller["PagePuller"]
       PullPlanner["PullPlanner"]
       Pusher["PagePusher"]
       Planner["LocalPlanner"]
       Placement["FolderPlacement"]
       Detector["RemoteDetector"]
       Discovery["DatabaseDiscovery"]
       Drift["RemoteDriftChecker"]
       Recovery["InterruptedSyncRecovery"]
       Observation["RunObservation"]

       Conflicts --> Puller & Pusher & Planner
       Inspector --> Puller & Planner
       PullPlanner --> Planner & Drift
       Puller --> Detector & Discovery & Placement & Drift
       Pusher --> Placement & Drift & Recovery
       Planner --> Placement
       Placement --> Drift & Recovery
       Detector & Drift --> Observation
   ```

   오케스트레이터는 이 모두를 만들어 넘기고 단계마다 부른다 — 그림은 모듈 사이의 의존만 그렸다. `RunObservation` 은
   받기 · 올리기 · 폴더 배치 · 충돌도 직접 받는다(그림에서는 줄였다).

5. **옮길 때 본문은 그대로 둔다.** 메서드 본문을 글자 그대로 옮겼다. 협력 객체의 필드 이름을 예전 필드 이름과 같게
   두어 `this.` 뒤가 바뀌지 않게 했고, 상태를 쥐지 않는 것은 함수로 옮겼다(`this.` 만 뗐다). 동작을 바꾼 곳은 없다.
   한 곳만 모양이 바뀌었다 — pull 이 시작할 때 따로 비우던 새 경로 · 첨부 수 · 파일 수를 `PagePuller.beginPull()`
   하나가 비운다.

## 선택지 — 어떻게 나누나

| 선택지                            | 판단                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 그대로 둠                         | 바꾸는 비용은 없다. 한 파일에 변경이 계속 몰리고, 실행별 상태를 누가 바꾸는지 계속 파일 전체로 본다       |
| 파일만 나누고 함수로(클래스 없이) | 실행별 상태를 인자로 들고 다녀야 한다 — 함수마다 인자가 늘고, 상태를 누가 쥐는지가 다시 흩어진다          |
| mixin · 부분 클래스               | TypeScript 에 부분 클래스가 없다. mixin 은 `this` 가 여전히 하나라 상태가 한 객체에 흩어진 채 남는다      |
| **협력 객체 + 생성자 주입**       | 상태를 그 일을 하는 객체가 쥐고, 무엇에 기대는지가 생성자에 드러난다. 레포가 이미 쓰는 방식 — **고른 것** |

## 트레이드오프

- **생성자 인자가 많다.** `PagePuller` 는 14개, `PagePusher` 는 12개다. 대신 무엇에 기대는지가 한곳에 드러난다.
- **한 흐름을 보려면 파일을 넘나든다.** pull 한 번이 `RemoteDetector` → `PagePuller` → `notion-link-pass` 를 거친다.
  순서는 오케스트레이터의 `executePull` 이 보인다.
- **비공개 멤버에 닿던 시험의 경로가 바뀌었다.** `orchestrator.test.ts` 9곳이 옮긴 메서드를 협력 객체(`pusher` ·
  `discovery`)를 거쳐 부른다. 시험의 기대값은 그대로다.
- **나누다 본 것은 이번에 고치지 않았다** — 동작을 바꾸지 않는 분리이기 때문이다. `docs/06-devlog/journal/2026-09-28.md`
  「오케스트레이터를 일마다 모듈로 나눔」 절에 적었다.

## 영향

- 추가(`core/sync/`): `run-observation.ts` · `interrupted-sync.ts` · `parent-mode.ts` · `notion-parent.ts` ·
  `discovered-databases.ts` · `database-discovery.ts` · `remote-drift.ts` · `remote-detector.ts` ·
  `missing-local-files.ts` · `folder-placement.ts` · `local-planner.ts` · `page-puller.ts` · `pull-planner.ts` ·
  `page-pusher.ts` · `conflict-workflow.ts` · `change-inspector.ts` · `notion-link-pass.ts`
- 수정
  - `core/sync/orchestrator.ts`: 5,791 → 1,133줄, 메서드 137 → 26개(게터 포함)
  - `core/sync/note-title.ts`: `extractTitle` · `titleProperty` · `extractAliases` 를 옮겨 왔다. `database-syncer.ts` 가
    쓰던 `extractAliases` 도 여기서 가져온다.
  - `core/sync/operation-gate.ts`: 실행별 상태가 어느 모듈에 있는지 설명을 고쳤다.
- 공개 API · 설정 · 상태 DB: 바뀌지 않았다. `SyncOrchestrator` 의 공개 메서드와 시그니처, `core/src/index.ts` 의
  export 가 그대로다. 새 모듈은 export 하지 않는다.

## 검증

- 커밋마다 빌드 · 린트 · 포맷 · 타입 · 시험 전량 — 모두 202 파일 · 2,901 통과 · 12 건너뜀, 분리 전(`487614b`)과 같다.
- 빌드한 선언 파일(`core/dist/index.d.ts`)의 export 231개와 `SyncOrchestrator` 의 공개 선언이 분리 전 빌드와 같다.
- 실 Notion(프로브 볼트, 2026-09-28): 분리 전 빌드(`487614b`)와 분리 뒤 빌드를 같은 볼트 · 같은 동작으로 번갈아
  불렀다. 상태 확인 · 증분 pull · dry-run · `--force` 의 요청 수와 결과가 같았다(`--force` 는 전체 대조 시각만 다르다).
  분리 뒤 빌드로 올리기 · 받기 · 충돌 해소 · 비교 · 되돌리기 · 행 올리기 · 생성 · 이름 변경 · 삭제를 한 번씩 탔다.
  단계별 표 — `docs/06-devlog/journal/2026-09-28.md` 「오케스트레이터를 일마다 모듈로 나눔」 절
