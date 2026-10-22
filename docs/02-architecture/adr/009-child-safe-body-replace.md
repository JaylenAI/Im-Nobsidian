# ADR-009: 자식이 있는 페이지의 본문 push — 삭제 불허 + 자식 태그 되돌리기

> 상태: 승인
> 결정일: 2026-09-27

## 맥락

폴더 노트처럼 **자식 페이지 · 자식(인라인) DB 를 가진 Notion 페이지** 는 본문을 통째로
바꾸면 자식까지 지워질 수 있다. v0.3.x 는 이를 막으려고(수정2) 자식이 있으면 본문 교체를
**통째로 건너뛰고도** `updated` 로 세고 해시를 올렸다(QA S-03). 옵시디언에서 고친 폴더 노트
본문이 Notion 에 영영 가지 않는데 오류도 경고도 없었다.

Notion Markdown API 실측 (2026-09-27, 프로브 페이지 — 자식 페이지 1 · 인라인 DB 1):

| 요청 (`replace_content`, `allow_deleting_content: false`) | 결과                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 자식 태그를 빼고 보냄                                     | `validation_error` 400 「This operation would delete N child page(s), database(s)…」 · 무변경 |
| 태그 대신 멘션(`<mention-page>`)으로 보냄                 | 같은 거절 · 무변경                                                                            |
| 받은 `<page url>` · `<database url>` 태그를 넣어 보냄     | 성공 · 자식이 같은 id 로 남는다                                                               |
| 태그의 위치를 옮겨 보냄                                   | 자식이 그 자리로 옮겨 간다 (같은 id)                                                          |

`update_content` 도 같은 규칙이다. 태그는 Notion 이 준 문자열 그대로 되돌리면 된다 —
자식 id 를 우리가 다시 조립할 필요가 없다.

## 결정

1. **본문 교체는 항상 `allow_deleting_content: false`** — `replacePageMarkdown` ·
   `updatePageMarkdownPartial`. 동기화가 자식을 지우는 경로를 없앤다.
2. **먼저 그대로 보낸다** (`sync/page-body.ts` `replacePageBody`). 자식이 없는 페이지는
   여기서 끝난다 — 추가 요청 0.
3. **거절(`validation_error`)이면** 지금 본문을 한 번 읽어 자식 태그를 뽑고, push 본문에서
   «그 자식을 가리키던 줄» 에 태그를 되돌려 **한 번 더** 보낸다 (+GET 1, +PATCH 1).
4. 줄 맞추기 규칙 (`converter/child-tags.ts` `restoreChildTags`, 위에서부터 먼저 맞는 것):

   | push 본문의 줄 (그 줄에 링크 하나만)                                           | 맞추는 기준                                                                         |
   | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
   | 해석된 `[[자식]]` 이 바뀐 멘션 `<mention-page url>`                            | id                                                                                  |
   | `.base` 임베드 자리표시자 `> 📎 이름.base %% im-nobsidian:local-file:… %%`     | 곁 파일 `.notion.json` 의 databaseId + 그 DB 를 가리키는 링크드 뷰 id → 없으면 제목 |
   | `.base` 를 못 만든 DB 자리표시 `**제목** *(Notion DB)*%%…child-database:id=%%` | id                                                                                  |
   | 해석되지 못한 `[[제목]]` · `[[경로/제목\|별칭]]`                               | 제목 (굵게 · 대소문자 무시, 페이지만)                                               |
   | 이미 태그인 줄                                                                 | id                                                                                  |
   - 코드 펜스 안은 보지 않는다. 한 자식은 먼저 나온 한 줄에만 놓는다.
   - 들여쓰기 · 인용 접두사는 지킨다. 자리표시자 인용(`>`)은 떼고 태그만 둔다.
   - **가리키는 줄이 없는 자식은 본문 끝에 덧붙이고 경고 로그** — 지우지 않는다.

5. 다시 보내도 거절이면 Notion 이 말한 사유를 담은 한국어 오류로 실패시킨다. 기존 push
   재시도 → `failed[]` 경로를 타며 동기화됨으로 기록하지 않는다.
6. **블록 방식**(`conversion.preferMarkdownApi: false`)은 자식이 있으면 보내지 않고 실패시킨다.
   기존 블록을 지우고 새 블록을 끝에 붙이는 방식이라 자식을 지키면서 순서를 지킬 수 없다.
   사유에 「기본값(true)으로 두고 다시 push」 를 적는다.
7. DB 행 본문(`database-syncer` `pushDatabaseRow`)도 같은 함수로 보낸다.
8. pull 쪽 짝: `.base` 임베드는 push 때 로컬 첨부 보존 마커로 저장되는데, 이제 그 자리는
   자식 DB 태그로 Notion 에 실제로 담긴다. pull 의 보존 마커 주입기는 `.base` 임베드 재작성
   (파이프라인 밖, DB 발견 뒤)보다 먼저 돌아 마커 줄을 다시 넣으므로, **재작성기가 임베드를
   되살린 `.base` 의 마커 줄을 걷는다** (`sync/db-placeholder-rewriter.ts`).

NFM 자식 태그 정규식은 `converter/child-tags.ts` 가, `<database>` 태그의 id 규칙은
`utils/inline-db-refs.ts` `databaseTagId` 가 한 벌만 갖고 변환기 · 발견 · 복원이 읽는다.

## 이유

- **되묻기(거절 후 복원)가 먼저 묻기보다 싸다.** 대부분의 페이지는 자식이 없어 1회로 끝난다.
  먼저 조회하면 모든 push 에 GET 이 1회 붙는다.
- **첫 시도가 안전하다.** 삭제 불허 요청은 거절될 때 아무것도 바꾸지 않는다(실측).
- **Notion 의 표현을 되돌린다.** 받은 태그 원문을 싣기 때문에 링크드 뷰 · 제목이 빈 DB ·
  호스트가 다른 url 도 그대로 통한다.
- **실패를 숨기지 않는다.** 되돌리지 못하면 사유와 함께 실패로 남고 다음 push 에서 다시 간다.

## 트레이드오프

- 자식이 있는 페이지는 본문 push 에 요청이 3회 든다 (거절된 PATCH · GET · PATCH).
- 자리를 못 찾은 자식은 **페이지 끝으로 옮겨진다** (삭제보다 낫다고 판단). 해당하는 모양:
  문장 속 · 목록 항목 속 링크, 별칭 붙은 해석 링크 `[별칭](Notion url)`, blocks-API 폴백의
  `> [!database]` 콜아웃 자리표시.
- 같은 제목의 자식이 여럿이면 Notion 본문 순서대로 짝짓는다.
- 인용(`>`) 안에 놓인 자식 태그 · 회의록(meeting note) 자식은 실측하지 못했다. 회의록은
  되돌릴 태그가 없으면 Notion 사유를 담아 실패한다.
- v0.3.x 에서 건너뛰고도 동기화됨으로 기록된 폴더 노트 편집은 **그 노트를 다시 고치기 전까지**
  재전송되지 않는다 (강제 재전송 명령이 없다 — 릴리스 노트에 안내).

## 영향

- 신규: `packages/core/src/converter/child-tags.ts`, `packages/core/src/sync/page-body.ts`
- 수정: `notion/client.ts` (삭제 불허 · `isNotionValidationError`), `converter/enhanced-md-converter.ts`
  (태그 정규식 · id 규칙을 읽기만), `utils/inline-db-refs.ts` (`databaseTagId`),
  `sync/orchestrator.ts` (`pageHasLiveChildren` 제거 · `.base` → DB id), `sync/database-syncer.ts`,
  `sync/db-placeholder-rewriter.ts` (마커 줄 걷기)

## 검증

- 단위: `child-tags` 17 · `page-body` 8 (실제 변환기로 push → pull 왕복 포함) ·
  `db-placeholder-rewriter` +2 · `orchestrator` 5 (거절 2회 → `failed` · 해시 안 올림 포함).
  마커 줄 시험 2개는 수정 전 코드에서 실패하는 것을 확인했다.
- 불변식 (실 Notion): 자식 페이지 · 인라인 DB 가 있는 부모의 본문 편집이 반영되고 자식이 같은
  id 로 남으며, `[[Leaf]]` 를 옮기면 자식도 옮겨 가고, 다시 push 하면 0건.
- 실데이터 E2E (프로브 볼트, 2026-09-27): `docs/06-devlog/journal/2026-09-27.md` 「S-03」 절.
