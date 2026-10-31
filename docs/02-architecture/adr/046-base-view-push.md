# ADR-046: 볼트에서 고친 `.base` 보기를 Notion 보기에 올린다 — 이름 · 열 · 정렬 · 필터

> 상태: 승인
> 결정일: 2026-10-29
> 0.12 의 「pull 은 고친 `.base` 를 덮지 않는다」 를 이어 — 붙잡아 둔 것을 push 가 올린다. ADR-045(사이드카)와 같은 꼴

## 맥락

- 보기는 Notion → 볼트 한 방향이었다. pull 은 Notion 보기를 `.base` 로 옮겨 쓰고, Obsidian 에서 고친 열 · 정렬 · 필터 · 이름은
  Notion 에 가지 않았다. 고친 `.base` 는 pull 이 덮지 않고 붙잡아 둘 뿐이었다(0.12, `warnEditedBase`)
- Obsidian 은 보기를 고치면 `.base` 를 통째로 다시 쓴다. 머리 주석(「pull 이 만든 파일」 표시)이 사라지고 키 차례 · 따옴표가
  바뀐다(1.13.7 실측). 그래서 고친 순간부터 pull 은 그 파일을 «사용자가 직접 만든 `.base`» 로 보고 다시는 쓰지 않았다
- 실측(2026-10-29, Notion-Version 2025-09-03):
  - `PATCH /views/{id}` — 빠진 필드는 그대로, `null` 은 지운다
  - `configuration.properties` 는 통째로 바뀐다 — 목록에 없는 속성은 숨겨지고, 목록 차례가 열 차례다
  - 보드는 `configuration.group_by`, 달력 · 타임라인은 `date_property_id` 를 함께 보내야 한다
  - 만든 · 고친 시각 정렬(`timestamp`)은 받지 않는다 — 400
  - 속성 id 는 URL 인코딩을 푼 꼴(`vc:X`)로 받는다
  - linked view: `POST /views` 에 `create_database: {parent: {page_id}}` 를 주면 그 페이지에 `child_database` 블록(제목
    "Untitled", `is_inline: true`, 원본의 data source)이 생긴다. 그 보기의 `parent` 는 linked DB 다. `GET /views?database_id=<원본>`
    은 원본 보기만, `?data_source_id=<소스>` 는 linked 보기까지 준다
  - Obsidian 1.13.7 의 `![[x.base#보기이름]]` 임베드는 그 이름의 보기를 연다

## 결정

1. **pull 이 쓴 보기를 기록한다**(`sync/base-view-record.ts`). `.base` 를 쓸 때 보기마다 Notion 보기 id · 타입 · 올리는 값(이름 ·
   열 · 정렬 · 필터) · 그때 Notion 보기의 지문(이름 · 타입 · 필터 · 정렬 · 설정 원본의 해시)을 상태 메타 `db_base_files` 에
   둔다. 보기 말고의 나머지(다른 키 · 보기의 다른 키)는 지문 하나로 둔다. 견주는 값은 쓴 글자가 아니라 **YAML 로 읽은 값**이다 —
   Obsidian 의 다시 쓰기(주석 · 키 차례 · 따옴표)를 고친 것으로 보지 않는다
2. **보기 기록이 있는 `.base` 는 머리 주석이 없어도 pull 이 쓴 파일이다.** 같은 경로에 보기 기록이 있으면 «이 볼트가 받아 쓴
   파일» 로 본다. 기록이 없는 옛 기록 · 다른 경로는 예전처럼 사용자 파일로 둔다
3. **push 가 고친 보기를 올린다**(`sync/base-view-push.ts` `BaseViewEdits`). 해시가 바뀐 기록 있는 `.base` 만 연다. 보기를
   기록과 잇는다 — 이름이 같은 것, 남은 것은 같은 자리 · 같은 타입(이름을 바꾼 보기). 바뀐 값만 보낸다:
   - 이름: 그대로. 빈 이름은 거절
   - 열: 제목 열을 맨 앞에, 볼트의 `order` 차례로 보이게, Notion 에 있던 나머지는 숨긴 채 뒤에. 보드 `group_by` · 달력 · 타임라인
     `date_property_id` 는 Notion 보기의 것을 함께 보낸다. 기간의 끝 열(`…_end`)은 시작 열과 한 속성이라 건너뛴다
   - 정렬: 속성 id 로. 빈 정렬은 `null`(지우기). `file.ctime` · `file.mtime` 은 거절(Notion 이 받지 않는다)
   - 필터: Bases 필터를 Notion 필터로 옮긴다(`view/bases-filter-to-notion.ts`). 지운 필터는 `null`
4. **필터 번역은 아는 꼴만, 모르면 전체를 거절한다.** pull 이 쓰는 꼴(정방향 번역기의 출력)과 Obsidian 필터 화면이 쓰는 꼴(따옴표
   없는 이름 · `note.` · `note["…"]` · `!` 함수 · `&&` · `||` · 괄호 · `today()` · `date("…")` · Notion 에 있는 상대 날짜 `today() ± "1d" · "7d" · "1M"` · 지난 · 다음 기간)을 읽는다.
   `and` 안의 하나만 못 옮겨도 필터 전체를 보내지 않는다 — 일부만 보내면 Notion 이 다른 행을 고른다. 수식 · `this` · 이 DB 에 없는
   속성 · 세 겹 묶음 · 숫자 · 날짜 비교의 부정 · 짝 없는 상대 기간은 거절한다. pull 때 Notion 필터에 `.base` 로 옮기지 못한 조건이
   있던 보기(`lossyFilter`)는 필터를 올리지 않는다 — 볼트 필터로 덮으면 그 조건이 사라진다
5. **충돌 · 거절.** 그 사이 Notion 에서도 그 보기를 고쳤으면(지문이 다르면) 올리지 않는다. Notion 에서 지운 보기 · 데이터 소스가
   여럿인 DB · 읽을 수 없는 YAML 도 거절한다. 거절과 실패는 사유를 적어 알린다
6. **다 올렸을 때만 다음 pull 이 `.base` 를 다시 쓴다.** 고친 것이 모두 올라가고, 기록과 잇지 못한 보기(볼트에서 더한 보기)가
   없고, 나머지 지문이 같을 때만 기록의 해시를 새 파일로 바꾼다. 하나라도 남으면 pull 은 계속 붙잡아 둔다 — 덮으면 그것을 잃는다
7. 결과는 `PushResult.viewEdits` · `PullResult.heldBases` 로 알리고, CLI · 플러그인이 한 줄씩 보인다. push 요약 줄은 노트 수와 함께
   DB 에 올린 것(만든 DB · 열 이름 · 사이드카 속성 · 보기)을 센다. dry-run 은 무엇을 올릴지만 알린다

## 이유

- 보기 id 는 Notion 보기마다 그대로다 — 기록에 id 를 두면 이름을 바꿔도 같은 보기에 올린다
- 지문 견주기는 ADR-045 의 사이드카와 같은 꼴이다. 보기만 고쳐도 DB 의 수정 시각이 바뀌지 않아(2026-10-23 실측) 시각으로는
  그 사이 Notion 에서 고쳤는지 모른다
- 필터를 반쯤 옮기는 것은 조용히 틀린 보기다. 거절하면 사용자가 Notion 에서 고칠 수 있다
- `configuration.properties` 가 통째로 바뀌므로, Notion 에 있던 열을 빠짐없이 다시 보내야 숨긴 열 · 열 폭이 사라지지 않는다

## 트레이드오프

- 볼트에서 더한 보기 · 지운 보기는 Notion 에 만들거나 지우지 않는다 — 그 `.base` 는 계속 붙잡아 둔다. ADR-048 결정 6 이 만들고 지운다
- Notion linked view 는 블록을 받아 원본 DB 의 `.base` 임베드로 둔다(F25). linked view 자체의 이름 · 필터 · 정렬은 `.base` 에 없다 —
  원본 보기 목록이 `database_id` 로만 읽기 때문이다. `#보기이름` 임베드로 옮길 길은 실측했다(다음 항목). ADR-048 결정 7 이 링크드 뷰마다
  자기 `.base` 를 쓴다
- 상대 날짜(`today()`)는 Obsidian 이 볼트의 지역 시각으로, Notion 이 워크스페이스 시각대로 센다 — 자정 근처에 하루가 다를 수 있다.
  실측하지 않았다
- 증분 pull 은 DB 가 바뀌어야 `.base` 를 다시 쓴다 — 올린 뒤 머리 주석이 돌아오는 것은 다음 전체 대조나 `pull --force` 다
- 0.12 이전에 받은 `.base`(보기 기록 없음)를 Obsidian 이 다시 쓰면 예전처럼 사용자 파일로 본다 — 한 번 `pull --force` 로 다시
  받아야 기록이 생긴다

## 영향

- 새 모듈: `view/bases-filter-to-notion.ts` · `view/bases-file-properties.ts` · `sync/base-view-record.ts` · `sync/base-view-push.ts`
- 고침: `view/base-file-generator.ts`(`generateWithViews` — 쓴 보기 목록) · `sync/db-base-files.ts`(보기 기록 · 나머지 지문) ·
  `sync/database-syncer.ts`(기록 · 주석 없는 파일 판정 · `heldBases`) · `sync/orchestrator.ts` · `notion/client.ts`(`updateView`)
- CLI(`viewEditLines` · `heldBaseLines` · 요약 줄) · 플러그인 알림 · `--json`(`viewEdits` · `heldBases`)
- 시험: `bases-filter-to-notion`(43) · `base-view-push`(15) · `database-syncer`(Obsidian 이 다시 쓴 `.base` 4)
