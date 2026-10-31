# ADR-047: 페이지 ↔ DB 이동 — 같은 페이지째 행 · 페이지로 바꾸고, 어느 쪽에서 옮겨도 따라간다

> 상태: 승인
> 결정일: 2026-10-30
> ADR-039(Notion 에서 옮긴 페이지 따라가기) · ADR-041(DB 가 든 폴더 옮기기)을 DB 안팎으로 넓힌다. 결정 D13

## 맥락

- 예전에는 볼트에서 행 노트를 DB 폴더 밖 · 다른 DB 폴더로, 페이지 노트를 DB 폴더 안으로 옮기면 push 가 거절했다. 막지 않으려면
  새로 만들고 지워야 했고, 그러면 페이지 id · 댓글 · 백링크를 잃는다
- 이미 페이지로 올린 노트 폴더는 `prepare-db` 가 거절해 DB 로 바꿀 길이 없었다
- 볼트에서 DB 폴더를 옮기면 볼트 쪽 자리만 바뀌고(ADR-041) Notion 의 DB 는 옛 부모 아래 옛 이름으로 남았다
- Notion 에서 페이지를 DB 안으로 · 행을 DB 밖으로 · 행을 다른 DB 로 · DB 를 다른 페이지 아래로 옮기면 볼트는 몰랐다.
  옮겨도 `last_edited_time` 이 바뀌지 않는다
- 실측(2026-10-27 ~ 30, Notion-Version 2025-09-03):
  - `POST /pages/{id}/move` 의 부모가 `data_source_id` 면 페이지가 그 DB 의 행이 된다. `database_id` 부모는 400 이다
  - 행을 페이지 아래로 옮기면 속성은 Notion 이 숨겨 보관하고(본문에 안 보임), DB 로 되돌리면 값이 돌아온다
  - 행을 다른 DB 로 옮기면 Notion 이 대상 DB 에 없는 열을 더한다
  - 페이지를 DB 로 옮기면 Notion 은 페이지의 frontmatter 를 모른다 — 볼트 값은 페이지 시절 본문의 속성 블록에만 있다
  - `PATCH /databases/{id}` 의 `parent` 로 DB 를 옮길 수 있다 — DB id · 행 · 보기 그대로. 수정 시각은 그대로다
  - 행의 부모는 `{"type":"data_source_id","data_source_id":…,"database_id":…}` 다
  - Obsidian Bases 의 `file.inFolder("폴더")` 는 하위 폴더까지 고른다 — 행의 하위 페이지(`행/…`)도 표에 행으로 나온다.
    `file.folder == "폴더"` 는 바로 안만 고른다(격리 Obsidian 1.12.4)

## 결정

### 볼트에서 옮긴 것 — push 가 Notion 을 맞춘다

1. **같은 페이지째 옮긴다**(`pages.move`, 부모 = 대상 DB 의 첫 데이터 소스). 옮긴 뒤 노트를 통째로 다시 보내 속성 ↔ 본문 YAML 을
   맞춘다. 받지 않은 Notion 편집이 있으면 덮지 않게 옮기지 않고 「pull 을 먼저 하세요」 로 거절한다
   - 페이지 → 행: frontmatter 를 대상 스키마의 속성으로, 본문 맨 위 속성 블록은 걷어 낸다
   - 행 → 페이지: 볼트 frontmatter 는 그대로 두고 페이지 규칙으로 올린다
   - 행 → 다른 DB: Notion 이 대상 DB 에 더할 열을 미리 보기 · 결과에 알린다(D13 — 막으려면 새로 만들고 지워야 해 손실이 더 크다)
2. **이미 올린 폴더를 DB 로**(`prepare-db` · 플러그인 「DB 로 바꾸기」) — DB 를 만들고 안의 페이지를 하나씩 행으로 옮긴다. 준비
   표시(`prepared_dbs`)를 남긴 폴더만 바꿔, 예전 push 가 폴더 페이지로 올린 폴더가 업그레이드만으로 DB 가 되지 않게 한다. 비게 된
   폴더 페이지만 휴지통에 넣는다. 끊기면 남은 페이지를 다음 push 가 옮긴다 — 준비 표시는 다 옮긴 뒤에 지운다
3. **DB 폴더를 옮기거나 이름을 바꾸면 Notion 의 DB 도**(`databases.update` 의 `parent` · `title`). 반영할 이동을 메타
   `db_moves_pending` 에 «마지막으로 Notion 에 반영한 폴더» 와 함께 적고 마치면 지운다(`sync/database-moves.ts`). 제목은 폴더 이름이
   DB 제목을 따르던 때만 바꾼다. 볼트가 받지 않는 곳(추적하지 않는 페이지 · 블록 안 · 루트 밖)의 DB 는 볼트 쪽만 옮기고 알린다

### Notion 에서 옮긴 것 — pull 이 볼트를 맞춘다

4. **전체 대조가 부모를 견준다.** 행은 순회에 안 나오므로 받는 DB 의 조회 결과로 본다
   - 페이지가 DB 조회에 나오면(레코드는 페이지) 행이 된다 — 노트를 DB 폴더로, 폴더 노트의 폴더 · 자식 폴더는 행의 하위 페이지
     폴더(`행/`)로. 빈 열이 볼트 frontmatter 값을 지우지 않게 **볼트 값을 지키고**(`keepPageValues`) 해시를 비워 다음 push 가
     행 속성으로 올리며 페이지 시절 본문의 속성 블록을 걷어 낸다
   - 행이 페이지 아래로 가면 페이지가 된다 — 노트 · 하위 페이지 폴더를 새 부모의 폴더로, frontmatter 는 볼트에 둔다
   - 행이 다른 DB 조회에 나오면 그 DB 폴더로 — 하위 페이지 폴더와 함께
5. **DB 를 다른 페이지 아래로 옮기면 폴더째**(`DatabaseSyncer.followPlacement`). 받은 DB 의 `parent` 가 볼트가 아는 페이지 ·
   루트이고 지금 폴더가 그 자리에 없으면 행 · `.base` 보기 · 사이드카 · 링크와 함께 옮긴다. 루트 아래면 `databases/` 선반으로. 맨 위에
   둔 DB 는 루트 아래 그대로 본다. 설정 파일로 정한 DB(`notion.databases`)는 설정을 고쳐 적을 수 없어 옮기지 않는다
6. 옮긴 노트 · 폴더를 경로로 적은 링크와 `.base` 의 폴더 필터는 ADR-039 · 041 처럼 고친다

### 양쪽

7. **볼트가 먼저다**(v0.10 규칙). 볼트에서 옮기고 아직 올리지 않은 노트 · 부모 노트 · DB 는 Notion 쪽 이동을 받지 않고, 다음 push 가
   Notion 을 볼트의 자리로 옮긴다. dry-run 은 옮겨 적지 않아 이동 WAL 이 없다 — 옮겨 적을 이동(`plannedPaths`)을 넘겨 실제 pull 과
   같은 판정 · 같은 까닭을 보인다
8. **전체 대조의 삭제 범위에 받는 DB 와 그 행을 넣는다.** 넣지 않으면 DB 안으로 옮긴 페이지 · 행의 하위 페이지가 «범위 밖으로
   옮겨진 것» 으로 보여 `deleteSync` 가 켜진 볼트에서 살아 있는 노트를 지웠다(2026-10-30 실측)
9. **`.base` 의 폴더 필터는 `file.folder == "폴더"`.** 예전 버전이 쓴 `file.inFolder` 는 pull 이 한 번 고쳐 쓴다(메타
   `base_folder_filter_v2`) — 바뀌지 않은 DB 는 다시 받지 않아 기다리면 계속 틀린다. Obsidian 이 머리 주석을 지운 파일도 보기 기록이
   있으면 pull 이 쓴 것으로 본다

## 이유

- 같은 페이지째 옮기면 id 를 지켜 링크 · 댓글 · 하위 페이지 · 다른 볼트의 기록이 산다. 새로 만들고 지우는 길은 그것을 모두 잃는다
- Notion 이 이동을 수정 시각에 남기지 않으므로 증분 조회로는 못 본다 — 부모 비교는 전체 대조(한 시간마다 · `pull --force`)에서 한다
- 볼트가 먼저인 규칙은 v0.10 의 페이지 이동과 같다 — 사용자가 마지막으로 손댄 곳이 볼트이고, push 가 Notion 을 맞출 수 있다

## 트레이드오프

- Notion 에서 옮긴 것은 다음 전체 대조까지 볼트에 나타나지 않는다(최대 한 시간, `pull --force` 는 바로)
- 행을 다른 DB 로 옮기면 대상 DB 에 열이 늘어난다 — 막지 않고 알린다(D13)
- Notion 에서 DB 제목만 바꾸면 `.base` · 사이드카 이름은 따라가지만 폴더 이름은 그대로다 — ADR-048 결정 3 이 폴더도 바꾼다
- 머리 주석도 보기 기록도 없는 `.base`(사용자가 만든 것)의 필터는 고치지 않는다 — ADR-048 결정 5 가 묻고 고친다

## 영향

- `notion/client.ts` — `movePageToDataSource`, `DatabaseMeta.parentPageId`, `updateDatabasePlacement`
- `sync/page-pusher.ts` · `sync/database-moves.ts` · `sync/folder-database.ts`(`prepared_dbs`) — push 쪽
- `sync/database-syncer.ts`(`pullDatabasePage` · `planDatabase` · `followPlacement`) · `sync/remote-detector.ts`(삭제 범위) ·
  `sync/remote-moves.ts` · `sync/pull-planner.ts` — pull 쪽
- `view/base-file-generator.ts` · `sync/db-folder-moves.ts` — `.base` 필터
- 상태 메타 `prepared_dbs` · `db_moves_pending` · `base_folder_filter_v2` 가 는다. 스키마는 그대로다
