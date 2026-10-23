# ADR-036: push 가 DB 를 만든다 — 사이드카가 스키마의 원본이다

> 상태: 승인
> 결정일: 2026-10-23
> 바꾼 것: 「뷰는 pull 만 한다」(`view/sidecar-generator.ts` 머리말) · DB 는 받기 전용이던 범위

## 맥락

DB 는 받기만 했다. pull 은 DB 하나를 볼트에 셋으로 쓴다.

- DB 폴더: 행마다 노트 하나, 속성은 frontmatter.
- `<DB>.base`: Obsidian Bases 뷰.
- `<DB>.notion.json` (사이드카): 속성 이름 · 타입 · 옵션 이름, 뷰 설정.

이 볼트를 새 루트로 push 하면 DB 폴더는 «폴더 페이지», 행은 «일반 페이지» 가 되고 속성은 본문의 YAML 로 갔다.
실데이터 E2E(2026-10-22)에서 행 959 개가 그렇게 페이지가 됐다. 스키마 · relation · 뷰는 Notion 에 가지 않았다.

### 실측 — 지금 API 로 되는 것 (2026-10-23, SDK 5.23.1 · API `2025-09-03`)

| 무엇                                                  | 결과                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `databases.create` + `initial_data_source.properties` | 18 타입 모두 만듦 — title · rich_text · number(format) · select · multi_select(옵션 색) · date · people · files · checkbox · url · email · phone_number · formula · unique_id(prefix 2자 이상) · created_time · last_edited_time · created_by · last_edited_by                                                                                                                                                                         |
| `dataSources.update` 로 status 추가                   | 됨. 옵션을 주면 그 옵션(첫 옵션이 기본값), 안 주면 Not started · In progress · Done. **그룹은 정하지 못한다** — 준 옵션은 모두 To-do 에 들고 `groups` 를 보내도 무시된다. 기본 세 옵션만 제 그룹에 든다                                                                                                                                                                                                                                |
| unique_id prefix                                      | **워크스페이스에서 하나뿐** — 같은 워크스페이스의 DB 가 이미 쓰면 409 `conflict_error` "Unique ID prefix is already in use."                                                                                                                                                                                                                                                                                                           |
| relation 추가                                         | dual · single 둘 다. dual 은 대상 DB 에 맞짝 속성이 생긴다                                                                                                                                                                                                                                                                                                                                                                             |
| rollup 추가                                           | 됨(relation · 대상 속성 이름 · 함수)                                                                                                                                                                                                                                                                                                                                                                                                   |
| 행 만들기                                             | `parent.data_source_id` · 스키마에 없는 select 옵션은 Notion 이 더한다                                                                                                                                                                                                                                                                                                                                                                 |
| 뷰                                                    | `POST /v1/views` 는 `database_id` 와 `data_source_id` 를 함께 받는다. table · board · list · gallery · calendar · timeline · form · chart 를 보낸 필터 · 정렬 · 그룹 · 열 설정 · 빠른 필터 그대로 만듦. map 은 장소 속성(`map_by`)이 있어야 한다. 속성은 **이름이 아니라 id** 로 가리킨다(보기는 `}TfS`, 속성 목록은 `%7DTfS` 꼴). DB 의 마지막 보기는 지우지 못한다(400). 보기 이름을 바꿔도 DB · data source 의 수정 시각은 그대로다 |
| 다시 읽기                                             | formula 는 `prop("수") * 2` 처럼 다시 보낼 수 있는 식으로, relation 은 대상 data source id 로, rollup 은 이름으로 돌려준다                                                                                                                                                                                                                                                                                                             |

## 결정

1. **사이드카가 스키마의 원본이다.** pull 은 사이드카(`schemaVersion: 2`)에 DB 를 다시 만들 수 있는 만큼 적는다.
   속성마다 타입별 설정(number format · 옵션 이름과 색 · status 그룹 · relation 대상 DB 와 dual 맞짝 이름 ·
   rollup · formula 식 · unique_id prefix), DB 의 제목 속성 이름 · 인라인 여부, 뷰의 원래 설정(filter · sorts ·
   configuration). v1 사이드카도 읽는다 — 옵션 이름만으로 만들고, 식 · relation · rollup 은 다시 받으라고 알린다.
2. **새 DB 폴더** 는 사이드카가 있고, 그 DB 를 이 볼트가 모르는(설정 · 자동 발견 · 접근 불가 · 링크드 · 만든 DB 어디에도
   없는) 폴더다. push 는 그 폴더를 페이지로 만들지 않고 DB 를 만든다.
3. 🔴 **사이드카의 DB 에는 쓰지 않는다.** 사이드카가 가리키는 것은 받아 온 곳의 DB 다 — 다른 루트 · 사용자의 실제
   워크스페이스일 수 있다. 언제나 새 DB 를 만들고, 원래 id → 새 id 를 상태 메타 `created_dbs` 에 적는다.
   relation 도 이 볼트가 만들었거나 이 루트에서 발견한 DB 로만 건다. 그 밖의 DB 로 가는 relation 은 만들지 않고
   알린다 — dual relation 은 대상 DB 에 속성을 더하므로, 남의 DB 를 바꾼다.
4. **차례.** 부모 페이지 → DB(평범한 속성) → 행 → relation → rollup → formula → 행의 relation 값 → 뷰.
   - DB 는 폴더의 자리를 마련할 때(`prepareFolders`) 만든다. 부모 페이지가 이번 push 의 새 노트면 그 노트를 먼저 올린다.
   - 만든 DB 는 자동 발견 목록에도 적는다 — 그 폴더의 노트가 기존 행 경로(`pushCreateRow`, ADR-015)로 간다.
   - relation 은 대상 DB 가 모두 생긴 뒤 붙인다. dual 은 한 번만 만든다 — 맞짝 쪽 사이드카의 같은 relation 은
     건너뛴다. formula 는 다른 속성을 가리킬 수 있어 마지막이다.
   - 행을 만들 때 대상이 아직 없는 relation 값은 행을 모두 만든 뒤 한 번 더 보낸다.
5. **부모 본문의 자리.** `.base` 임베드는 `created_dbs` 로 새 DB 를 가리킨다 — 부모 본문을 다시 보낼 때 DB 가 임베드
   자리에 선다(ADR-009 의 자식 되돌림).
6. **뷰** 는 사이드카에 적힌 원래 설정(`configuration` · `filter` · `sorts` · `quickFilters`)으로, 속성을 다 붙인 뒤
   차례대로 만든다(`sync/database-views.ts`). 속성 id 는 받아 온 DB 의 id → 이름 → 새 id 로 바꾼다. 새 DB 에 없는 속성의
   열 · 정렬은 빼고, 필터 · 그룹이 그런 속성을 가리키면 그 보기를 만들지 않고 알린다. 보기를 하나라도 만들면 Notion 이
   넣은 기본 보기를 지운다. dashboard 는 만들지 않는다(위젯은 옮기지 않는다). 끊기면 다음 push 가 이미 만든 보기(이름)를
   건너뛰고 이어 만든다 — 올릴 노트가 없는 push 도 이어 만든다.
7. 끌 수 있다 — `sync.createDatabases: false` 면 예전처럼 폴더 · 페이지로 올린다.

## 이유

- 사이드카는 pull 이 이미 쓰는 파일이고 DB 폴더 안에 있다. 새 파일 · 새 형식을 만들지 않는다.
- 사이드카의 DB 에 행을 더하는 길(링크)은 다른 루트로 옮긴 볼트가 원래 DB 에 행을 붓는다. 실데이터 E2E 가
  동기화 블록으로 바로 이것을 겪었다(원본 4개를 다시 씀, 2026-10-22). 새로 만드는 쪽만 안전하다.
- 스키마를 행 frontmatter 에서 짐작하면 타입이 갈린다(날짜인지 글인지, select 인지 multi 인지). 받은 DB 를 다시
  만드는 데는 받은 스키마가 정확하다. 사이드카 없는 Obsidian Bases 는 #75(v0.6.0)에서 다룬다.

## 트레이드오프 — Notion 이 받지 않아 같지 않은 것

- unique_id 값 · created/last_edited 시각 · 만든 사람은 Notion 이 새로 매긴다 — 다시 받으면 frontmatter 의 그 값이 바뀐다.
- unique_id prefix 는 받아 온 DB 와 같은 워크스페이스면 겹쳐 접두어 없이 만든다(알림).
- status 그룹 — 기본 세 옵션이 원래 있었으면 기본으로 만들어 제 그룹에 두고, 나머지 옵션은 To-do 에 둔다(원래 그룹과
  다르면 알림). 옵션 이름도 바꿀 수 없다.
- 속성 순서 — data source 의 속성은 순서 없는 맵이다. 다시 받으면 frontmatter · `.base` 의 속성 순서가 바뀔 수 있다.
- 루트 아래 DB 들의 폴더(`databases/`)는 pull 이 만든 자리다 — 페이지로 만들지 않고 그 안의 DB 를 루트 아래에 만든다.
- people 값은 이름으로만 볼트에 있어 보내지 않는다(사용자 id 를 알 수 없다).
- dashboard 보기(위젯), button · verification 속성은 만들지 않는다.
- 볼트 밖 DB 를 가리키던 relation · 그 relation 을 쓰는 rollup 은 만들지 않는다.
- 보기 설정은 받은 그대로 보낸다 — Notion 이 거절한 보기(장소 속성 없는 map 등)는 알리고 건너뛴다. 보기 id 는 새로 매겨진다.

## 영향

- `view/sidecar-generator.ts`(v2) · pull 의 스키마 읽기 · `sync/folder-placement.ts`(새 DB 폴더) · 새 `sync/database-creator.ts` ·
  `notion/client.ts`(databases.create · dataSources.update · views) · `sync/page-pusher.ts`(`.base` 임베드 id · 행 relation 재전송).
- 상태 메타 `created_dbs` 가 생긴다. 스키마 변경(migration)은 없다.
