# ADR-021: 코드 펜스 언어는 Notion 이름으로 보내고, 원래 표기는 받기 직전의 로컬 노트에서 되살린다

> 상태: 승인
> 결정일: 2026-09-28

## 맥락

Obsidian 코드 펜스의 정보 문자열은 자유다 — `ts` · `py` 같은 별칭, 언어 없는 펜스, `dataview` ·
`dataviewjs` · `tasks` 같은 플러그인 쿼리, `python title="a.py"` 같은 속성. Notion 코드 블록의 언어는
정해진 90개다. push 는 정보 문자열을 그대로 보냈다.

실측(2026-09-28, 프로브 페이지 두 장 · 펜스 168개, `pages.create` 와 `replace_content` 가 같다):

| 보낸 펜스                                                                  | Notion 이 저장한 것                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------ |
| 정식 이름 88개(`python` · `plain text` · `llvm ir` …) · 대소문자 섞인 이름 | 그 이름(소문자)                                        |
| 정식 이름 `ascii art` · `java/c/c++/c#`                                    | javascript                                             |
| Notion 이 아는 별칭(`ts` · `js` · `py` · `sh` · `md` · `yml` · `text` …)   | 정식 이름                                              |
| Notion 이 모르는 별칭(`zsh` · `console` · `golang`)                        | javascript                                             |
| 언어 없음 · `dataview` · `dataviewjs` · `tasks` · `query` · 속성 붙은 정보 | javascript                                             |
| `~~~` 펜스                                                                 | 코드 블록이 아니다 — 이스케이프된 문단                 |
| 네 개 이상 백틱 펜스                                                       | 안쪽의 ``` 줄에서 블록이 갈리고, 정보는 세 백틱 뒤부터 |
| 코드 블록 캡션                                                             | markdown 으로 오가지 않는다                            |

그래서 Notion 에서 Dataview 쿼리 · 언어 없는 펜스가 JavaScript 로 칠해졌고, `~~~` 펜스는 코드가
아니었다. pull 은 Notion 이름을 적었다 — Notion 에서 그 페이지를 고친 뒤 처음 받으면 노트의 `ts` 가
`typescript` 로, `dataview` 가 `javascript` 로 바뀌어 Dataview 쿼리가 죽었다(S-20).

## 결정

1. **push 는 Notion 이름만 보낸다**(`CodeLanguageGuard`, 전처리 46). 별칭은 Notion 이 옮기는 것과
   같게 옮기고, Notion 이 놓치는 흔한 별칭(`zsh` → shell · `golang` → go …)도 옮긴다. 모르는 것 · 빈
   정보 · 펜스로 보낼 수 없는 두 이름은 `plain text` 로 보낸다. 코드에 백틱 세 개 줄이 없으면 `~~~` ·
   긴 펜스를 백틱 세 개 펜스로 바꾼다. 닫히지 않은 펜스는 어디까지가 코드인지 확신할 수 없어 건드리지 않는다.
2. **언어 목록의 주인은 SDK 타입이다**(`LanguageRequest`). 펜스로 보낼 수 있는지를
   `Record<NotionCodeLanguage, boolean>` 로 적어, SDK 에 언어가 늘거나 줄면 타입 오류가 난다.
3. **pull 은 받기 직전의 로컬 노트에서 원래 표기를 찾는다**(`CodeLanguageRestorer`, 후처리 36 ·
   `ProcessorMetadata.localContent`). 짝짓기는 두 번이다.
   - 코드가 같은(공백 무시) 로컬 펜스 — 펜스 기호와 정보 문자열을 그대로 되돌린다.
   - 남은 것 중 Notion 언어가 같은 로컬 펜스 — Notion 에서 코드를 고친 블록이다. 정보 문자열만
     되돌린다. 남은 수가 같으면 순서대로, 다르면 같은 줄이 있는 것끼리 같은 줄이 많은 짝부터.
   - 언어가 맞지 않으면 짝짓지 않는다 — Notion 에서 언어를 바꾼 것이니 그쪽을 따른다.
4. **이 버전 전에 올린 페이지**의 javascript 블록은 코드가 같고 원래 표기가 정식 이름이 아닐 때만
   되돌린다(`dataview` · 맨 펜스). 원래 `python` 이던 블록이 javascript 로 오면 Notion 에서 바꾼 것이다.
5. **블록 방식 push(`preferMarkdownApi: false`)도 같은 언어로 보낸다.** martian 은 정보 문자열의 첫
   낱말만 제 표로 옮겨 여러 낱말 이름을 잃고 `text` 를 vb.net 으로 보낸다. 만든 블록의 언어를 같은
   코드의 펜스 언어로 덮는다(`applyFenceLanguages`).
6. 로컬 노트를 읽지 못하면 경고를 남기고 Notion 이름으로 받는다 — 받기는 멈추지 않는다.

## 선택지 — 원래 표기를 어디에 두나

| 선택지                                    | 판단                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 보존 마커(`%% … %%`)를 Notion 본문에 싣기 | 코드 블록 안에는 넣을 수 없다 — 코드가 바뀐다. 블록 밖에 두면 Notion 에 보이는 글이 생긴다                    |
| 코드 블록 캡션                            | markdown 으로 오가지 않는다(실측)                                                                             |
| 상태 DB 에 push 때의 표기를 적기          | 이 버전 전에 올린 노트 · 다른 기기에서 올린 노트에는 기록이 없다. 저장 스키마가 는다                          |
| **받기 직전의 로컬 노트**                 | 로컬 노트가 곧 원래 표기다. 예전에 올린 노트 · 다른 기기에서 올린 노트도 된다. 저장할 것이 없다 — **고른 것** |

## 트레이드오프

- **로컬 노트가 없는 곳에서는 Notion 이름으로 받는다** — 새 기기에서 처음 받기 · 지운 노트 되살리기.
  `dataview` 쿼리는 `plain text` 펜스로 온다(이 버전 전에는 `javascript`).
- **예전 push 의 javascript 블록을 Notion 에서 코드까지 고쳤으면 javascript 로 받는다.** Notion 에서
  JavaScript 로 바꾸고 고친 블록과 가를 수 없다. 로컬 노트를 한 번 고쳐 push 하면 Notion 쪽이 Notion
  이름으로 돌아가(E2E X3) 그 뒤로는 생기지 않는다.
- **Notion 에서 블록을 더하고 고친 것이 섞이면 짝을 잘못 지을 수 있다.** 같은 Notion 언어끼리만
  짝지으므로 잘못 지어도 같은 언어의 표기끼리 바뀐다(`dataview` ↔ 맨 펜스).
- 받을 때마다 로컬 노트를 한 번 더 읽는다.
- Notion 에서 JavaScript 로 칠해지던 Dataview 쿼리가 Plain Text 가 된다 — 의도한 것이다.
- 코드에 ``` 줄이 있는 펜스는 어떤 펜스로 보내도 Notion 이 그 줄에서 블록을 가른다 — 펜스는 둔다(S-22,
  따로 다룬다).

## 영향

- 새 파일: `converter/code-language.ts`(언어 옮기기) · `converter/code-fence.ts`(펜스 찾기) ·
  `pre-processors/code-language-guard.ts` · `post-processors/code-language-restorer.ts`
- 수정: `converter/pipeline-factory.ts`(등록) · `converter/block-converter.ts`(`applyFenceLanguages`) ·
  `types/convert.ts`(`localContent`) · `sync/vault-fs.ts`(`readLocalNote`) · `sync/orchestrator.ts`
  (`renderRemotePage`) · `sync/database-syncer.ts`(`renderRow` 의 `localPath` — 행을 옮기며 받을 때 옛 자리)
- 공개 API · 상태 DB 스키마 · 설정: 변경 없음

## 검증

- 단위 · 통합: `tests/converter/code-language.test.ts`(119) · `tests/sync/code-language-roundtrip.test.ts`(7) ·
  `tests/sync/read-local-note.test.ts`(3) · `tests/sync/database-syncer.test.ts`(행을 옮기며 받기). 적용되는 뮤테이션을
  모두 잡는다.
- 실데이터 E2E s20a — 12/14. Notion 이 저장한 언어 · 받은 노트의 펜스 줄 · 예전 push 의 javascript 블록 · 블록 방식 ·
  다시 받기와 `push --dry-run` 의 바뀔 것 0 을 확인했다. 실패 둘은 이 결정과 무관하다(목록 안 코드 블록 들여쓰기 S-24 ·
  하니스 기대값). `docs/06-devlog/journal/2026-09-28.md` 「코드 펜스 언어 (S-20)」 절
