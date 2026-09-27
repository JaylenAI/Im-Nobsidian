# ADR-011: 로컬 이동 · 이름 변경 — 짝지어 옮겨 적고, Notion 에는 부모와 제목만 바꾼다

> 상태: 승인
> 결정일: 2026-09-27

## 맥락

볼트에서 노트를 옮기거나 이름을 바꾸면 변경 감지에는 «추적 경로에 파일이 없음» 과 «추적하지
않는 새 파일» 두 가지만 보인다. v0.3.x 는 이것을 이렇게 다뤘다(S-11).

| 경우                    | v0.3.x                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 이름만 바꿈 (내용 같음) | 짝은 지었지만(`moved`) push 가 레코드를 새 경로로 찾아 못 찾고 끝났다. 그런데 `updated` 로 세어 매 push 가 같은 이름 변경을 다시 보고했다. 제목도 부모도 바뀌지 않았다 |
| 다른 폴더로 옮김        | 부모를 `pages.update({ parent })` 로 보냈다 — Notion 은 이 필드를 조용히 무시한다. 실패는 로그만 남았다                                                                |
| 이름과 내용을 함께 바꿈 | 짝을 못 찾아 새 페이지를 만들었다. 옛 페이지는 Notion 에 남았다(deleteSync 꺼짐) — 페이지 id · 댓글 · 백링크가 끊긴다                                                  |
| 옮기고 push 전에 pull   | 옛 경로의 파일이 없으니 «사라진 노트» 로 보고 옛 자리에 되살렸다 — 같은 노트가 두 곳에 생긴다                                                                          |
| 폴더 이름을 바꿈        | push 가 만든 폴더 페이지는 옛 이름 그대로, 안의 노트는 각자 «옮김» 으로 셌다                                                                                           |
| 본문만 고침             | 매 갱신이 파일 이름으로 만든 제목을 다시 보냈다 — Notion 에서 바꾼 제목이 되돌아갔다                                                                                   |

## 결정

1. **짝짓기 근거는 셋, 앞의 것이 이긴다** (`sync/local-moves.ts` `pairLocalMoves`).
   1. 이름 변경 힌트 — 플러그인이 Vault `rename` 이벤트로 적어 둔 «지금 경로 → 옛 경로»
      (상태 메타 `local_rename_hints`). 이름과 내용을 함께 바꿔도 짝을 찾는다.
   2. 입양해 둔 이동의 옛 자리 — 옮겨 적고 아직 반영하지 않은 노트가 그 자리로 돌아온 경우.
   3. 같은 내용 — 같은 파일 이름을 먼저, 그다음 경로 순으로 정해 결과가 매번 같다.
2. **먼저 상태 DB 에 옮겨 적는다(입양).** push · pull 모두 시작할 때 레코드 경로 · 위키링크 ·
   보존 마커를 새 경로로 옮긴다. Notion 에 반영할 것은 이동 WAL(`pending_operations`,
   `operation = 'move'`)의 payload `{ from }` — **마지막으로 Notion 에 반영한 경로** — 로 남긴다.
   반영하기 전에 그 자리로 돌아오면 WAL 을 닫는다. 다른 길(pull 의 DB 행 재배치)로 제자리에 온
   WAL 도 다음 실행이 닫는다. dry-run 은 옮겨 적지 않고 같은 모습을 겹쳐 본다(`localView`).
3. **Notion 에는 부모와 제목만 바꾼다** (`relocatePage`). 부모는 `pages.move`
   (`notion/client.ts` `movePage`) — `pages.update` 의 `parent` 는 무시된다. 제목은 페이지를 한 번
   읽어 정한다(`titleAfterMove`): frontmatter `title` 로 정한 제목은 그대로 두고, 옛 파일 이름을
   따르던 제목이면 새 파일 이름으로 바꾼다. 내용도 바뀌었으면 이어서 갱신한다. 반영을 마치면 WAL
   을 닫는다. 도중에 끊기면 다음 push 가 같은 옛 경로로 다시 한다 — 옮기기와 제목 바꾸기는 다시
   해도 결과가 같다.
4. **폴더.** push 가 만든 폴더 페이지(폴더 레코드)는 폴더 힌트, 없으면 안 노트들의 짝으로 새
   자리를 정해(`deriveFolderMoves`) 폴더 페이지의 제목 · 부모만 바꾼다 — 얕은 것부터. 자동 발견
   DB 폴더를 옮기면 `discovered_dbs` 의 폴더만 바꾼다. Notion 의 DB 는 옮기거나 이름을 바꾸지
   않는다.
5. **Notion 에서 그렇게 옮길 수 없으면 거절한다** — 요청하지 않고 이유와 함께 `failed` 로 남긴다.

   | 옮긴 것                                    | 거절하는 이유                                                 |
   | ------------------------------------------ | ------------------------------------------------------------- |
   | DB 행을 제 DB 폴더 밖 · 다른 DB 폴더로     | Notion 에서 행을 DB 밖 · 다른 DB 로 옮기면 속성이 사라진다    |
   | 페이지를 DB 폴더로                         | DB 에는 행만 든다                                             |
   | 폴더를 DB 폴더 안으로                      | 같은 이유                                                     |
   | DB 폴더 안의, 같은 이름의 행이 없는 폴더로 | Notion 에 같은 자리가 없다 — 새 노트의 자리 규칙(S-04)과 같다 |

6. **제목 규칙은 한 곳에** (`sync/note-title.ts`). 새로 만들 때는 `noteTitle(frontmatter, 경로)`.
   갱신은 frontmatter `title` 이 지난 동기화와 달라졌을 때만 제목을 보낸다(`changedPageTitle`).
   pull 은 이동을 반영하기 전이면 옛 파일 이름을 따르는 원격 제목을 `title:` 로 적지 않는다 —
   적으면 push 가 그것을 사용자가 정한 제목으로 보고 이름 변경을 제목에 반영하지 않는다.
7. **pull 은 볼트부터 본다.** 옮긴 노트를 옮겨 적고, 옮겨 적는 노트는 되살리지 않는다. 볼트를
   읽지 못하면 옮긴 노트와 지운 노트를 가를 수 없으므로 이번 pull 은 사라진 노트를 되살리지
   않는다(이유를 로그로 남긴다). dry-run pull 은 옮겨 적을 노트를 새 경로로 보인다.

## 이유

- **페이지 id 를 지킨다.** 댓글 · 백링크 · 공유 설정 · Notion 쪽 하위 페이지 · DB 관계가
  끊기지 않는다.
- **요청이 적다.** 이름 변경은 페이지 읽기 1 + 제목 1, 이동은 여기에 `pages.move` 1. 본문은
  보내지 않는다.
- **옮겨 적기를 먼저 해 pull · push · status 가 같은 경로를 본다.** 옛 자리 되살리기와 새 경로
  이중 생성이 구조적으로 생기지 않는다.
- **WAL 의 옛 경로는 뜻이 하나다** — «마지막으로 반영한 자리». 끊김 · 되돌리기 · 여러 번
  옮기기가 같은 규칙으로 풀린다. 스키마는 바꾸지 않았다 — `pending_operations` 는 처음부터
  `move` 를 허용했다.

## 트레이드오프

- **CLI 는 힌트가 없다.** 이름과 내용을 함께 바꾸면 짝을 몰라 새 페이지를 만든다(dry-run 이
  「생성 1 · 삭제 1」 로 보인다. deleteSync 가 꺼져 있으면 옛 페이지는 Notion 에 남는다). 앱을 끈
  채 파일 관리자로 옮긴 경우도 같다. 플러그인은 rename 이벤트로 짝을 찾는다.
- 같은 내용의 파일이 여럿이면 이름 · 경로 순으로 짝짓는다 — 사람이 뜻한 짝과 다를 수 있다.
  내용이 같으니 본문 손실은 없다.
- **폴더 노트는 파일 이름이 폴더 이름과 같을 때만 폴더의 페이지다.** 폴더 이름만 바꾸면 폴더
  노트가 보통 노트가 되어, 새 폴더 페이지 아래로 형제와 함께 옮겨진다 — 볼트 모습 그대로다.
  폴더와 폴더 노트를 함께 바꾸면(folder-notes 플러그인 방식) 제목만 바뀐다.
- DB 폴더 이동은 볼트 쪽 자리만 바뀐다. Notion DB 의 이름 · 위치는 그대로다.
- 거절된 행 이동은 옮겨 적힌 채 남아 매 push 가 이유와 함께 보고한다. 다음 pull 이 그 행을 제
  DB 폴더에 다시 쓴다.
- frontmatter `title` 이 있는 노트는 이름을 바꿔도 Notion 제목이 그대로다 — 사람이 정한 제목으로
  본다.
- 이름을 바꾸면서 frontmatter `title` 도 고치면 제목을 두 번 보낸다(`relocatePage` ·
  `pushUpdate`). 결과는 같다.
- 설정 DB 폴더의 행은 짝짓지 않는다 — 설정 DB 동기화가 따로 다룬다(`fix/configured-db-row-push`).
- CLI 진행 표시는 옮긴 노트를 `updated` 로 보이고, 폴더 이동은 수에만 든다. 변경 목록
  API(`feature/sync-status-api`)에서 `moved` 로 따로 보인다.

## 영향

- 신규: `sync/local-moves.ts`(짝짓기 · 힌트 · 폴더 이동 · 이동 WAL payload),
  `sync/note-title.ts`(제목 규칙)
- 수정: `sync/change-detector.ts`(`scanLocalChanges*` — 입양 목록과 `moved`),
  `sync/orchestrator.ts`(입양 · `pushMove` · `pushFolderMoves` · `relocatePage` · 거절 · 제목),
  `sync/folder-container.ts`(`isFolderNotePath` · `isFolderRecord`), `sync/row-properties.ts`
  (`rowTitle` → `noteTitle`), `notion/client.ts`(`movePage` → `pages.move`), 플러그인
  `main.ts`(Vault rename · delete 이벤트) · `sync/sync-controller.ts`(`onVaultRename` ·
  `recordDelete`)
- 공개 API: `SyncOrchestrator.recordLocalRename` · `recordLocalDelete`, 타입 `LocalScan` ·
  `LocalScanOptions` · `LocalMoveAdoption` · `RenameHints` · `RenameKind`
- 상태 DB: 스키마 변경 없음. 새 메타 키 `local_rename_hints`.

## 검증

- 단위: `tests/sync/local-moves.test.ts` 32 · `note-title.test.ts` 18 ·
  `local-move-push.test.ts` 20(실 StateDB + 메모리 볼트 · Notion) · `change-detector.test.ts` 12 ·
  `pull-restore-deleted.test.ts` 15 · `folder-container.test.ts` 15 · `write-retry-safety.test.ts`
  (옮기기 504 재전송) · 플러그인 `sync-controller.test.ts` 17(이름 변경 · 삭제 3)
- 불변식(실 Notion) 15/15
- 실데이터 E2E (프로브 볼트, 2026-09-27): `docs/06-devlog/journal/2026-09-27.md` 「S-11」 절
