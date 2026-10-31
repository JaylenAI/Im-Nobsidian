# ADR-051: Obsidian 에서만 쓰는 것을 기본으로 빼기

> 상태: 승인
> 결정일: 2026-10-31
> 「Notion API 한계를 빼고 모두 동기화」 계획의 P9 · 결정 D10

## 맥락

볼트에는 Notion 에서 쓸 수 없는 것이 있다.

- Canvas(`*.canvas`)와 Excalidraw(`*.excalidraw.md` · `*.excalidraw`) — 안이 JSON 이다. Notion 에 그대로 올리면 수천 줄의 글
  또는 열 수 없는 파일 블록이 되고, Notion 에서 고칠 수 없다
- 템플릿 폴더의 틀 — `{{date}}` · `<% tp.date.now() %>` 같은 자리표시가 든 글이다. Notion 에서는 쓸모가 없고 페이지 목록만 어지럽힌다

## 선택지

1. 지금처럼 모두 올리고, 빼려면 사용자가 `paths.exclude` 를 적는다 — 처음 쓰는 사람은 올라간 뒤에야 안다
2. 확장자로 늘 뺀다 — 템플릿 폴더 이름은 볼트마다 달라 확장자로 알 수 없다
3. **설정 하나(`paths.excludeObsidianOnly`, 기본 켬)로 빼고, 템플릿 폴더는 Obsidian 설정에서 읽는다**

## 결정

3 을 택한다. 켜져 있으면 `*.canvas` · `*.excalidraw.md` · `*.excalidraw` 와 템플릿 폴더(코어 「템플릿」 의 `templates.json` ·
Templater 의 `templates_folder`)를 제외 패턴에 더한다. 플러그인은 `vault.configDir` 를 읽는다(사용자가 설정 폴더 이름을 바꿀 수
있다). 폴더 연결은 템플릿 폴더를 제 폴더 기준으로 옮긴다 — 연결 밖이면 더하지 않고, 템플릿 폴더 자신이나 그 안을 연결했으면
빼지 않는다(사용자가 고른 것이다).

## 이유

- 제외된 자리의 기록은 지운 것으로 보지 않는다(FilteredVaultFS) — 이미 올린 볼트가 업그레이드해도 Notion 페이지가 지워지지
  않는다(deleteSync 를 켜도 — CLI · 플러그인 실측)
- 템플릿 폴더 이름을 사용자에게 다시 묻지 않는다 — Obsidian 이 이미 안다

## 트레이드오프

- Canvas 를 Notion 에 파일로 두고 싶던 사람은 설정을 꺼야 한다
- 설정 파일 없이 경로 설정을 직접 만든 코드(라이브러리 사용자)는 `true` 를 주지 않으면 빼지 않는다 — 스키마의 기본값은 켬
- 템플릿 폴더 설정을 읽지 못하면(파일 없음 · 깨진 JSON) 확장자만 뺀다

## 영향

- `utils/obsidian-only.ts` — `OBSIDIAN_ONLY_PATTERNS` · `TEMPLATE_FOLDER_SETTINGS` · `templateFolders` · `obsidianOnlyExcludes`
- CLI `utils/vault.ts` `openVaultFs` · 플러그인 `connection-engine.ts` `obsidianOnlyPatterns` · 설정 「Obsidian 에서만 쓰는 것은 빼기」
- 시험: `tests/utils/obsidian-only.test.ts` · CLI `tests/utils/vault.test.ts` · 플러그인 `tests/main.test.ts`
