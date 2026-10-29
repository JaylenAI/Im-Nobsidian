# ADR-045: DB 스키마를 양쪽에서 고친다 — Notion 은 속성 id 로 따라가고, 볼트는 행 · 사이드카로 올린다

> 상태: 승인
> 결정일: 2026-10-29
> ADR-036 결정 3 을 좁힌다 — 이 볼트가 받아 온 DB 의 사이드카에 한해 그 DB 에 쓴다

## 맥락

- pull 은 속성 이름을 frontmatter 키로 쓴다. Notion 에서 속성 이름을 바꾸면 다음 pull 은 옛 키를 남긴 채 새 키를 더했고, push 는
  옛 키를 «Notion 에 없는 로컬 키» 로 보고 넘어갔다. 지운 속성의 키는 볼트에 영영 남았다
- 볼트에서 키 이름을 바꾸면 push 는 새 키를 모르는 속성으로 보고 보내지 않았다 — 옛 열은 값이 그대로였다
- 사이드카(`<db>.notion.json`)는 pull 이 쓰는 원본이다(ADR-036). 고쳐도 다음 pull 이 덮었고, 고친 것이 Notion 에 가지 않았다
- 데이터 소스가 여럿인 DB 는 행을 만들지 못했다(아래 실측)
- 실측(2026-10-29, Notion-Version 2025-09-03):
  - `PATCH /data_sources/{id}` 의 `properties` 는 **속성 id 를 키로** 받는다 — `{[id]: {name}}` 이름 바꾸기 · `{[id]: null}` 지우기 ·
    `{[id]: {number: {}}}` 타입 바꾸기(rich_text `"12"` → number 12 로 옮겨진다)
  - select 옵션을 `[{name: "가", color: "red"}, {name: "나"}]` 로 보내면 옵션이 늘고, 있던 옵션의 색은 그대로다
  - 이름으로 formula(`prop("점수표") * 2`) · date 를 더할 수 있다
  - 이미 있는 이름으로 바꾸면 200 이고 Notion 이 말없이 「X 1」 로 둔다
  - 스키마를 바꿔도 행의 `last_edited_time` 은 그대로다 — 증분 pull 은 행을 다시 받지 않는다
  - 데이터 소스가 여럿인 DB 에 `parent: {database_id}` 로 행을 만들면 400 「Databases with multiple data sources are not
    supported in this API version」. `parent: {data_source_id}` 는 된다

## 결정

1. **Notion → 볼트: 속성 id 로 따라간다.** pull 은 data source 마다 본 스키마(속성 id → 이름 · 타입)를 상태 메타 `db_schemas` 에
   둔다(`sync/schema-ledger.ts`). 다음 pull 은 지난번과 견줘 — 이름이 바뀐 id 는 행 노트의 키를 바꾸고(값 · 키 순서 그대로),
   없어진 id 의 키는 지우고, 새로 생기거나 타입이 바뀐 속성은 행을 다시 받아 채운다(`refreshed`). 행의 수정 시각이 그대로여도
   한다(위 실측). date 의 끝 키(`… 끝`)도 같이 따라간다. 처음 보는 DB 는 기록만 한다
2. **볼트 → Notion: 행 노트에서 키 이름을 바꾸면 속성 이름을 바꾼다**(`sync/schema-push.ts` `VaultSchemaRenames`). 다음이
   모두 맞을 때만 이름 바꾸기로 본다 — 그 DB 의 행들이 지난 사본(base snapshot)을 갖고, 바뀐 행 모두에서 옛 키 A(그 DB 의
   속성)가 빠지고, A 가 비어 있지 않던 바뀐 행은 모두 새 키 B 를 갖고, 적어도 한 행의 B 가 A 의 옛 값과 같고, 바뀌지 않은 행에는
   A · B 가 없고, B 가 그 소스에 없는 이름이고, A 를 가진 소스가 하나다. 하나라도 어긋나면 이름 바꾸기로 보지 않는다 —
   여럿으로 읽히는 것은 거절하고 알린다
3. **볼트 → Notion: 이 볼트가 받아 온 DB 의 사이드카를 고치면 스키마를 바꾼다**(`sync/sidecar-schema-edit.ts`). pull 이 쓴
   사이드카의 해시 · 속성을 상태 메타 `sidecar_bases` 에 두고, push 는 해시가 다른 사이드카만 연다. 만든 이가 im-nobsidian 이고
   `databaseId` 가 같은 것만. 지난번 속성과 견줘 — 이름 · 타입 · 설정(formula · number · select · multi_select)이 바뀌면 속성 id 로,
   더한 속성은 이름으로, 지운 속성은 `null` 로 보낸다. 거절: 제목 속성을 지우거나 타입을 바꾸거나 더하기 · 제목 말고 모두 지우기
   (2개 이상일 때) · 같은 이름 · id 둘 · 모르는 id · 설정을 옮기지 못하는 타입의 설정 바꾸기 · 데이터 소스가 여럿인 DB ·
   그 사이 Notion 에서도 스키마가 바뀐 DB. 🔴 ADR-036 결정 3(사이드카의 DB 에 쓰지 않는다)은 **다른 볼트 · 다른 루트에서 가져온
   사이드카** 에 그대로다 — 기록(`sidecar_bases`)이 없는 사이드카는 고친 것으로 보지 않는다
4. **pull 은 고친 사이드카를 덮지 않는다.** 속성을 고친 사이드카(`sidecarPropertiesEdited`)는 그대로 두고 알린다(`heldSidecars`) —
   다음 push 가 올린다. 보기만 고친 사이드카는 예전처럼 다시 쓴다(ADR-036 결정 1)
5. **데이터 소스가 여럿인 DB 의 행.** 새 행은 첫 소스(`data_source_id`)를 부모로 만들고 그 소스의 스키마로 옮긴다. 고친 행은
   그 행이 사는 소스(`parent.data_source_id`)의 스키마로 옮긴다 — 합친 스키마로 옮기면 다른 소스에만 있는 속성까지 보내 행
   전체가 거절된다. 소스가 하나뿐인 DB 는 예전처럼 DB 를 부모로 둔다
6. 결과는 `PullResult.schemaFollowed` · `heldSidecars`, `PushResult.renamedProperties` · `schemaEdits` 로 알리고, CLI · 플러그인이
   한 줄씩 보인다. dry-run 은 무엇을 바꿀지만 알린다

## 이유

- 이름은 바뀌고 id 는 그대로다(실측) — id 로 따라가야 「옛 키 + 새 키」 가 남지 않는다
- 행 노트의 키 바꾸기는 Obsidian 속성 패널의 「이름 바꾸기」 가 남기는 꼴 그대로다. 값만 지우고 다른 키를 더한 것과 섞이지
  않게, 값이 옮겨 간 증거(정확히 같은 값)를 한 행 이상 요구한다
- 사이드카는 이미 스키마를 다시 만들 수 있을 만큼 적는다(ADR-036). 새 파일 형식을 만들지 않고 그것을 고치게 한다
- 남의 DB 를 바꾸지 않는다는 ADR-036 의 이유는 「어디서 왔는지 모르는 사이드카」 다. 이 볼트가 받아 쓴 기록이 있는 사이드카는
  그 DB 를 이 볼트가 동기화하고 있다는 뜻이다

## 트레이드오프

- 행이 하나뿐인 DB 에서 키 이름을 바꾸며 값도 고치면 이름 바꾸기로 보지 못한다(같은 값 증거가 없다) — 새 키는 로컬 키로,
  옛 열은 비워진다. 값을 고치는 것은 다음 push 로 나누라고 문서에 적는다
- 데이터 소스가 여럿인 DB 의 사이드카 편집은 거절한다 — 사이드카가 소스를 나눠 적지 않는다
- 이미 있는 이름으로 바꾸기는 거절한다(Notion 이 「X 1」 로 바꿔 둔다)
- 옵션을 지우는 것(select 에서 옵션을 빼기)은 실측하지 않았다 — 보낸 목록에 없는 옵션을 Notion 이 지우는지 모른다
- push 마다 기록한 사이드카를 읽어 해시를 잰다(API 호출 없음)

## 영향

- 새 모듈: `sync/schema-ledger.ts` · `sync/schema-follow.ts` · `sync/schema-push.ts` · `sync/sidecar-bases.ts` · `sync/sidecar-schema-edit.ts`
- 고침: `sync/database-syncer.ts`(`followSchema` · 고친 사이드카 지키기) · `sync/orchestrator.ts`(이름 바꾸기 · 사이드카 편집을
  행보다 먼저) · `sync/frontmatter-merge.ts`(`rekeyRowFrontmatter`) · `sync/row-schema-cache.ts` · `sync/page-pusher.ts`
  (소스별 스키마 · 새 행의 부모) · `notion/client.ts`(`data_source_id` 부모)
- CLI(`schemaFollowedLines` · `renamedPropertyLines` · `schemaEditLines` · `heldSidecarLines`) · 플러그인 알림 · `--json`
- 시험: `schema-ledger` · `schema-follow-pull` · `schema-rename-push` · `sidecar-schema-edit` · `multi-source-row-push`
