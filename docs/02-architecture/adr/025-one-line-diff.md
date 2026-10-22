# ADR-025: 줄 비교는 core 한 벌 — 지난 동기화 사본과 견주고, 보기는 잠그지 않는다

> 상태: 승인
> 결정일: 2026-09-28

## 맥락

변경 패널은 무엇이 바뀌었는지(A/M/D · 옮김 · 원격)만 보였다. 항목을 누르면 노트가 열릴 뿐이었다. 그래서 올리기(↑) ·
되돌리기(↺) · 받기(↓) 전에 무엇이 어떻게 바뀌었는지 볼 곳이 없었다. Obsidian Git 은 파일을 누르면 줄 비교를 보인다.

줄 비교는 이미 세 벌이 있었고, 셋 다 달랐다(코드).

| 어디                                  | 예전 비교                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 플러그인 충돌 창(`conflict-modal.ts`) | 같은 번호의 줄끼리 견줌. 앞에 한 줄만 더해도 그 뒤 모든 줄이 바뀐 것으로 보임. 파일 전체를 보임     |
| core `generateDiff`(CLI `resolve`)    | 같은 방식. 부호 뒤에 빈칸을 두어(`- ` · `+ `) 표준 통합 diff 가 아님                                |
| CLI `diff`                            | jsdiff `createTwoFilesPatch` 를 따로 부름 — 문맥 4줄 · `===` 줄. 옮긴 노트 · 사본 없는 노트는 빈 줄 |

화면 시험(happy-dom)은 테마 색을 계산하지 않는다. 실제 Obsidian(1.13.7)에서 열어 보니 바뀐 줄의 글이 보이지 않았다. 바탕은
`--background-modifier-error`, 글은 `--text-error` 였는데, 기본 테마에서 둘은 같은 색이다(실측: 어두운 #fb464c · 밝은
#e93147, 성공 쪽도 같음). 옛 충돌 창도 2026-05-23(`24d1b0c`)부터 이 규칙을 썼다.

## 결정

1. **줄 비교는 core 의 `lineDiff` 한 벌이다.**
   - jsdiff `structuredPatch` 를 감싼다. 문맥은 3줄로 Git 과 같다. 바뀐 양이 2,000(`MAX_EDIT_LENGTH`)을 넘으면 줄을
     맞추지 않고 통째로 바꾼 것으로 낸다.
   - 결과는 구조로 낸다: `DiffHunk` · `DiffLine`(옛 번호 · 새 번호). 끝 줄바꿈이 없다는 표시는 바뀐 줄에만 붙인다.
   - 화면은 이 구조를 그린다. 글이 필요한 곳(CLI · `generateDiff`)은 `formatUnifiedDiff` 로 Git 식 글을 만든다. 부호는
     `DIFF_SIGN` 하나를 쓴다.
2. **무엇과 무엇을 견주나.**
   - 로컬 변경은 지난 동기화 사본(`baseSnapshot`)과 지금 볼트의 글을 견준다. Git 의 HEAD 와 작업 트리다.
   - 원격 변경은 지난 동기화 사본과 Notion 의 지금 글을 견준다. Notion 글은 pull 과 같은 변환으로 만들고, 첨부는 내려받지
     않는다. Git 이 받을 커밋을 합칠 기준(merge-base)과 견주는 것과 같다. 지금 볼트 글과 견주면 로컬 편집이 원격 변경처럼
     섞여 보인다.
   - 충돌은 예전처럼 볼트 글과 Notion 의 지금 글을 견준다.
3. **보기는 잠그지 않는다.** `OperationGate`(ADR-024) 밖이다. 읽기만 하고 실행별 상태를 쓰지 않으니, 긴 pull 이 도는 동안에도
   볼 수 있다. 대신 다음 경우에는 이유를 담아 거절한다.
   - 변경 목록이 본 레코드와 지금 레코드의 글 지문(`previousHash`)이 다르다: 새로고침한 뒤 다시 보라고 한다.
   - 지난 동기화 사본이 없다: 없는 글과 견주면 모든 줄이 새 줄로 보인다.
   - 아직 받지 않은 새 페이지이거나 폴더다.
4. **바뀐 줄은 옅은 바탕에 보통 글색으로 쓰고, 부호만 오류 · 성공 색으로 칠한다.**
   - 바탕은 `rgba(var(--color-red-rgb), 0.15)` 와 `rgba(var(--color-green-rgb), 0.15)` 다.
   - 테마가 같은 색으로 둘 수 있는 바탕 · 글 변수를 한 규칙에서 함께 쓰지 않는다. `tests/styles.test.ts` 가 이것을 막는다.

## 선택지

| 선택지                             | 판단                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 화면마다 따로(예전)                | 셋이 다르게 보이고, 하나를 고치면 나머지는 그대로 남는다                                                           |
| 가장 긴 공통 줄을 직접 구현        | 표 방식은 두 글 길이의 곱만큼 메모리를 쓴다. 검증된 구현이 이미 의존성에 있다                                      |
| **jsdiff 를 core 에서 감쌈**       | CLI 가 이미 쓰던 의존성이다. `maxEditLength` 로 최악의 시간을 막는다 — **고른 것**                                 |
| 원격 비교를 지금 볼트 글과         | 받으면 볼트가 어떻게 될지와 가깝다. 하지만 로컬 편집이 원격 변경으로 섞여, 원격에서 무엇이 바뀌었는지 가를 수 없다 |
| **원격 비교를 지난 동기화 사본과** | 원격에서 바뀐 것만 보인다. 로컬 편집은 로컬 변경이 따로 보인다 — **고른 것**                                       |
| 보기도 잠금 안에                   | 실볼트 pull(500초) 동안 아무것도 볼 수 없다                                                                        |

## 트레이드오프

- 원격 비교는 첨부를 내려받지 않는다. 비교를 보려다 볼트에 파일이 생기면 안 되기 때문이다. 그래서 아직 받지 않은
  미디어는 원격 URL 로 남아 차이로 보인다.
- 원격 비교는 받은 뒤의 볼트, 곧 로컬 편집과 합친 결과를 보이지 않는다. 양쪽을 다 고쳤으면 충돌로 올라와 충돌 창이
  두 글을 보인다.
- 2,000 넘게 바뀐 두 글은 줄을 맞추지 않고 통째로 바꾼 것으로 보인다.
- 옅은 바탕은 `--color-red-rgb` · `--color-green-rgb` 에 기댄다. 이 변수를 두지 않는 테마에서는 바탕 없이 부호 색으로만
  가른다.
- 잠그지 않는다. 그래서 창을 여는 사이에 도는 pull 이 레코드를 바꾸면 거절된다. 새로고침한 뒤 다시 본다.

## 영향

- 추가
  - `core/utils/line-diff.ts`
  - `cli/utils/diff-output.ts`: `diff` · `resolve` 가 같은 색으로 찍는다
  - `obsidian-plugin/change-diff-modal.ts` · `change-diff-text.ts`
  - `obsidian-plugin/views/ChangeDiffView.svelte` · `DiffLines.svelte`
- 수정
  - `core/conflict/resolver.ts`(`generateDiff`) · `core/sync/orchestrator.ts` · `core/types/sync.ts` · `core/index.ts`
  - `cli/commands/diff.ts` · `resolve.ts`
  - `obsidian-plugin/conflict-modal.ts`: 충돌 창도 `DiffLines` 를 쓴다
  - `obsidian-plugin/main.ts` · `sync/sync-controller.ts` · `views/SyncDashboard.svelte` · `views/sync-sidebar-view.ts`
  - `obsidian-plugin/styles/main.css` · `styles.css`
- 공개 API(계약 변경)
  - 추가: `lineDiff` · `formatUnifiedDiff` · `DIFF_SIGN` · `DiffHunk` · `DiffLine` · `LineDiffOptions` · `ChangeDiff`
  - 추가: `SyncOrchestrator.localChangeDiff` · `remoteChangeDiff`
  - `generateDiff`(`generateConflictDiff`)가 표준 통합 diff 를 낸다.
    - 새 모양: 묶음 머리 `@@`, 부호 뒤 빈칸 없음, 같은 줄은 앞뒤 3줄만 보임, 같은 글이면 「(로컬과 원격의 내용이 같습니다)」.
    - 예전 모양: 파일 전체, `- ` · `+ ` · 두 칸.
  - CLI `diff`
    - 문맥이 4줄에서 3줄로 줄고 `===` 줄이 없어졌다.
    - 옮긴 노트는 `rename from` · `rename to` 를 적는다. 비교하지 못한 노트는 이유를 보이고 종료 코드 1 로 끝낸다.
    - `--remote` 는 옮긴 노트의 Notion 쪽 이름을 옛 자리로 적는다. 같은 글이면 같다고 알린다.
  - 의존성: `diff`(jsdiff)를 cli 에서 core 로 옮겼다.
- 상태 DB 스키마 · 설정: 변경 없음

## 검증

- 단위 · 통합
  - `core/tests/utils/line-diff.test.ts`
  - `core/tests/sync/change-diff.test.ts`: 메모리 Notion 위 오케스트레이터
  - `core/tests/conflict/resolver.test.ts`
  - `cli/tests/commands/diff.test.ts` · `resolve.test.ts` · `cli/tests/utils/diff-output.test.ts`
  - `obsidian-plugin/tests/change-diff-modal.test.ts` · `conflict-modal.test.ts` · `styles.test.ts`
  - `obsidian-plugin/tests/views/change-diff-view.test.ts` · `sync-dashboard.test.ts` · `sync-sidebar-view.test.ts`
  - `obsidian-plugin/tests/sync/sync-controller.test.ts`
- 변이 · 실데이터 화면 E2E — `docs/06-devlog/journal/2026-09-28.md` 「변경 패널 · CLI 의 줄 비교」 절
