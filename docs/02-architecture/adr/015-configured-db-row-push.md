# ADR-015: 설정 DB · DB 모드의 행 push 는 오케스트레이터의 행 경로를 탄다

> 상태: 승인
> 결정일: 2026-09-28

## 맥락

설정 DB(`notion.databases`)의 행은 오케스트레이터의 변경 목록 밖에서 따로 올라갔다. 페이지 push 가
끝나면 `DatabaseSyncer.pushAll` 이 설정 DB 폴더의 직속 파일을 모두 읽고, 해시가 다르면 보냈다.

자동 발견 DB 의 행은 S-01 · S-02 · S-04 · S-07 · S-11 · N-04 를 거치며 행 경로를 갖췄다
(`pushCreateRow` · `pushRowUpdate` · `pushMove` · `pushDelete`). 설정 DB 의 행만 옛 경로에 남았다.

| 무엇                             | 옛 경로                               | 결과                                              |
| -------------------------------- | ------------------------------------- | ------------------------------------------------- |
| 갱신                             | 모든 속성을 보내고 본문을 통째로 바꿈 | Notion 에서 고친 속성을 로컬 값으로 덮음          |
| 수정 시각                        | 보낸 뒤 늘 원격 시각을 적음           | Notion 쪽 변경을 다음 pull 이 받지 못함           |
| 충돌                             | 레코드 상태를 보지 않음               | 충돌 행도 올림                                    |
| 생성                             | WAL · 입양 없음                       | 응답을 받지 못하면 다음 push 가 행을 하나 더 만듦 |
| 이름 변경                        | 해시가 같을 때만 경로를 옮겨 적음     | Notion 제목은 그대로, 내용도 바꾸면 새 행 + 옛 행 |
| frontmatter                      | `gray-matter` 를 그대로               | 읽지 못한 frontmatter 가 «속성 없음» 이 됨(S-13)  |
| 변환                             | 파이프라인 · 첨부 업로드 없이 본문만  | 같은 노트가 페이지일 때와 다르게 올라감           |
| dry-run · `--path` · 제외 · 중단 | 보지 않음                             | dry-run 에 나오지 않고, 범위 밖의 행도 올림       |
| 삭제                             | 보지 않음                             | deleteSync 를 켜도 Notion 행이 남음               |
| 행 이름의 하위 폴더에 든 노트    | 직속 파일만 봄                        | 영영 올라가지 않음                                |

DB 모드(`parentMode: database`)는 갱신만 행 경로였다. 생성은 페이지 경로 안의 분기였다. 모든 속성을
보냈고, 조상 폴더를 Notion 페이지로 만들었고(DB 모드에서는 쓰이지 않는 빈 페이지), 생성 요청이
적용됐는지 모르면 입양하지 않고 새로 만들었다.

## 결정

1. **설정 DB 폴더의 직속 노트는 자동 발견 DB 의 행과 같은 경로를 탄다.** 새 행과 행 레코드의 DB 를
   찾는 곳(`folderLookup`)은 이미 설정 DB 를 먼저 본다. 변경 목록에서 설정 DB 경로를 빼던 필터와
   `DatabaseSyncer.pushAll` 호출을 지운다.
2. **DB 모드의 새 노트는 루트 DB 의 행으로 `pushCreateRow` 를 탄다.** 폴더는 Notion 의 자리를 정하지
   않는다 — 폴더 페이지를 만들지 않는다.
3. **DB 모드 행의 레코드는 `file` · `folder-note` 로 적는다.** DB 모드의 pull · 복원 · 렌더는 그
   볼트의 노트를 모두 페이지 레코드로 다룬다. `db-row` 로 적으면 복원(`detectMissingLocalFiles`)이
   빠뜨리고, 렌더가 설정 DB 의 렌더러로 간다. 행인지는 전역 모드로 가른다(`rowDatabaseOf`).
4. **`DatabaseSyncer` 의 push 경로를 지운다**(`pushAll` · `pushDatabase` · `pushDatabaseRow`).
   `DatabaseSyncer` 는 pull 만 한다.
5. **변경 감지의 `excludeFromMoves` 를 지운다.** 설정 DB 행을 이동으로 짝짓지 않던 선택지다. 이제
   설정 DB 행의 이름 변경도 `pushMove` 가 반영한다.

## 이유

- **같은 계약을 두 경로가 나눠 가지면 한쪽이 빠진다.** R9a · R9e · R11-A · R13 과 같은 결함류다. 옛
  경로에 행 경로의 규칙을 하나씩 옮겨 심는 대신 경로를 하나로 합친다.
- **행 경로는 이미 실데이터로 검증됐다**(S-01 · S-04 · S-07 · S-11 · N-04). 설정 DB 는 DB 를 찾는
  곳만 다르다.

## 트레이드오프

- **동작이 바뀐다.** 릴리스 노트에 적는다.
  - deleteSync 를 켠 볼트에서 설정 DB 행 파일을 지우면 Notion 행도 휴지통으로 간다. 예전에는 남았다.
  - `push --dry-run` 이 설정 DB 행을 세고, `--path` 는 범위 밖의 설정 DB 행을 올리지 않는다.
  - 충돌로 표시된 설정 DB 행은 `resolve` 전까지 올라가지 않는다.
  - 설정 DB 행 이름의 하위 폴더에 든 노트(`Tasks/행/하위.md`)가 그 행 아래 페이지로 올라간다.
  - DB 모드는 새 노트의 조상 폴더를 Notion 페이지로 만들지 않는다. 앞선 버전이 만든 빈 폴더
    페이지는 그대로 남는다.
- **공개 API: `DatabaseSyncer.pushAll()` 삭제.** 0.x 의 마이너 변경이다.
- **새 행 아래 하위 폴더의 노트는 한 번 재시도한다.** 행이 생기기 전에는 그 폴더의 자리가 없다 —
  재시도 전에 폴더를 다시 보고 올라간다(`retryWaitMs`, 기본 2초). 자동 발견 DB 의 행과 같다.

## 영향

- 수정: `sync/orchestrator.ts`(설정 DB 필터 · `pushAll` 호출 삭제, DB 모드 생성 → `pushCreateRow`,
  `newRowFileType`), `sync/change-detector.ts`(`excludeFromMoves` 삭제), `sync/database-syncer.ts`(push
  경로 삭제)
- 시험 하니스: 메모리 Notion 이 DB 행을 흉내 낸다 — 부모가 DB 인 페이지는 속성을 갖고, DB 조회
  (`queryAllDatabasePages`)로만 보이며, 자식 페이지 목록에 잡히지 않는다
- ADR-014 결정 6(설정 DB 행의 맨 앞 H1 되살리기를 `DatabaseSyncer.pushDatabaseRow` 에서)은 이 결정으로
  행 경로의 되살리기(`restoreCreatedHeading`)에 합쳐진다
- 상태 DB 스키마 · 설정: 변경 없음

## 검증

- 단위: `tests/sync/configured-db-row-push.test.ts` 17(설정 DB 15 · DB 모드 2, 실 StateDB + 메모리 볼트
  · Notion). 옛 코드에서 14개가 깨진다. 통과하는 셋은 새 행 생성 · deleteSync 꺼짐의 복원 · N-04 다
- 지운 시험: `DatabaseSyncer.pushAll` 단위 12 · push 시간 상한 3 · `excludeFromMoves` 1. 새 행 · 속성
  하나만 · 이름 변경 · 위키링크 · 본문 실패 · 시간 상한은 위 시험이 오케스트레이터 경로로 잠근다
- 전량 150 파일 · 1,966 통과(건너뜀 3 파일 · 11), 불변식(실 Notion) 15/15 · 151초
- 실데이터 E2E (프로브 DB 2개, 2026-09-28): `docs/06-devlog/journal/2026-09-28.md` 「설정 DB · DB 모드의
  행 push」 절
