# ADR-044: 증분 pull 은 추적 중인 페이지 · 행을 차례로 원격에 물어 삭제를 가른다

> 상태: 승인
> 결정일: 2026-10-28

## 맥락

- 증분 pull(ADR-027)은 지난 pull 뒤에 바뀐 것만 search 로 찾는다. 삭제는 전체 대조(기본 1시간)만 가렸다 — 다른 기기에서
  Notion 에서 지운 노트가 그동안 볼트에 남았다. 플러그인은 몇 분마다 증분 pull 을 한다
- 조회 필터(`pullFilter`)를 단 DB 는 조회에 없는 행이 필터 밖인지 지워진 것인지 몰라 전체 대조도 가르지 않았다 — 휴지통 행이
  볼트에 영영 남았다
- 실측(2026-10-28, Notion-Version 2025-09-03) — **지운 것을 목록으로 받을 길이 없다**:
  - search 는 휴지통 페이지를 돌려주지 않는다. `filter: { property: "in_trash" }` · 본문의 `in_trash` · `archived` 는 400
  - data source 조회도 휴지통 행을 빼고, `in_trash` · `archived` 를 넣으면 400
  - 자식 페이지를 휴지통에 넣어도 부모의 `last_edited_time` 은 그대로다(자식을 만들면 바뀐다). 휴지통 자식은 부모의
    `blocks/children` 에서 빠진다
  - 부모를 휴지통에 넣으면 자식 · 손자도 `GET /pages` 가 `in_trash: true` 다
- 남는 길은 페이지마다 `GET /pages/{id}`(`remotePresence`)로 묻는 것뿐이다. 계획 문서의 「search `filter.in_trash`」 는
  없는 기능이다

## 결정

1. **pull · dry-run 의 감지 끝에 삭제 확인을 붙인다**(`sync/deletion-sweep.ts` · `RemoteDetector.sweepDeletions`). deleteSync 가
   켜져 있고 첫 pull 이 아닐 때만 — 전체 대조가 삭제를 가르는 조건과 같다. 상태 확인(`status`)은 묻지 않는다
2. **증분**은 추적 중인 페이지 · 행 모두를 차례에 둔다. search 가 이번에 살아 있다고 보인 것 · 이미 변경으로 잡힌 것은 뺀다
3. **전체 대조**는 조회 필터를 단 설정 DB 의 행만 차례에 둔다 — 나머지는 순회 · DB 조회가 가른다
4. 한 번에 `DELETION_SWEEP_BUDGET`(15)개만 묻는다. 차례는 압축 page id 순이고, 다음 pull 은 상태 메타
   `deletion_sweep_cursor` 뒤부터 묻는다. 이보다 작은 볼트는 pull 마다 모두 묻는다
5. 지워진 페이지가 보이면 그 아래 추적 페이지(`notionParentId` 를 따라)는 차례와 상관없이 같은 pull 에서 묻는다 — 폴더 하나를
   지운 것이 여러 pull 에 나뉘어 보이지 않게. 추정해서 지우지 않고 하나씩 묻는다(그 사이 다른 곳으로 옮겼을 수 있다)
6. 지워졌으면 `remoteDeletionChange` 로 내고, 받는 쪽은 예전 그대로다(`pullDelete` → `applyRemoteDeletion` — 올리지 않은
   로컬 편집은 전략을 본다). 살아 있으면 아무것도 하지 않는다 — 옮긴 것은 전체 대조가 가른다
7. 커서는 pull 이 마칠 때 적는다(`saveDeletionSweep`). dry-run · 경로를 좁힌 pull · 취소된 pull 은 적지 않는다
8. 결과의 `remoteScan.deletionsDeferred` 는 이번에 모두 묻지 못했을 때만 참이다 — 작은 볼트의 증분 pull 은 「지운 것은 다음
   전체 대조 때」 를 더 알리지 않는다

## 이유

- 묻는 것 말고는 길이 없다(위 실측). 모두 묻으면 증분이 전체 대조만큼 비싸진다 — 예산으로 묶는다
- 15건은 요청 간격(350ms)으로 약 5초다. 노트 300개 볼트면 20번의 pull(플러그인 5분 주기면 100분) 안에 모두 한 번 묻는다 —
  전체 대조 주기(1시간)와 비슷하지만, 작은 볼트 · 최근에 지운 폴더는 바로 보인다
- 필터 DB 의 «필터 밖» 행은 살아 있다고 답한다 — 지우지 않는다. 묻는 수는 예산 안이라 필터 밖 행이 쌓여도 pull 이 느려지지 않는다

## 트레이드오프

- pull 마다 최대 15 요청이 는다(원격이 그대로여도)
- 큰 볼트에서 한 장만 지운 것은 차례가 올 때까지(또는 전체 대조까지) 남는다 — 화면은 `deletionsDeferred` 로 알린다
- 필터 DB 에서 필터 밖으로 나간 행은 계속 추적되고 차례마다 한 번씩 물어진다

## 영향

- `sync/deletion-sweep.ts`(새) · `sync/remote-detector.ts`(`sweepDeletions` · `deletionsChecked` · `saveDeletionSweep`) ·
  `sync/orchestrator.ts`(마감에서 커서 저장 · `deletionsDeferred`) · `sync/remote-scan.ts` `remoteScanInfo`
- 시험: `tests/sync/incremental-deletion-sweep.test.ts` · 메모리 search 가 휴지통을 빼도록(`tests/helpers/memory-sync.ts`)
