# ADR-031: SQLite 엔진(wasm)을 main.js 에 싣는다

> 상태: 승인
> 결정일: 2026-10-11

## 맥락

플러그인의 상태 DB 는 sql.js 다(ADR-006). 그 엔진은 wasm 파일이고, 지금까지는 릴리스에 네 번째 파일로 두었다.
플러그인은 켜질 때 `<볼트>/.obsidian/plugins/<id>/sql-wasm.wasm` 을 읽었다(U-04).

- **디렉터리 설치는 세 파일만 받는다.** Obsidian 은 릴리스에서 `main.js` · `manifest.json` · `styles.css` 만
  내려받는다. 디렉터리 · BRAT 으로 설치하면 엔진이 없어 첫 실행부터 초기화가 실패한다.
- **설정 폴더를 바꾼 볼트에서는 경로부터 틀렸다.** 설정 폴더 이름은 사용자가 고를 수 있다(설정 → 파일 및
  링크, 앱 코드 `getOverrideConfigDir`). 플러그인은 `.obsidian` 을 코드에 적어 두었다.
- 실측(격리 Obsidian 1.13.7, dev 빌드)
  - 네 파일을 `.obs-cfg/plugins/…` 에 두어도 `.obsidian/plugins/…/sql-wasm.wasm` 을 찾다 ENOENT.
  - 세 파일만 둔 `.obsidian` 볼트도 같은 ENOENT.
- 디렉터리 검사(`obsidianmd/obsidian-workflows` v1.2.3)도 설정 폴더를 코드에 적은 줄을 오류로 낸다
  (`hardcoded-config-path`).

## 결정

1. **엔진을 main.js 에 싣는다.** esbuild 의 `binary` 로더가 `sql.js/dist/sql-wasm-browser.wasm` 을 바이트
   (`Uint8Array`) 그대로 번들에 넣는다(`esbuild.config.mjs`). `main.ts` 는 그것을 `SqlJsStateDB.open` 의
   `wasmBinary` 로 넘긴다. 플러그인 폴더에서 읽는 파일이 없다.
   - 번들은 `sql-wasm-browser.js` 글루를 쓴다(esbuild `conditions: ["browser"]`). 짝이 되는 같은 이름의 wasm 을
     싣는다. `sql-wasm.wasm` 과 바이트가 같다(실측).
   - 시험(vite)에는 그 로더가 없다. `vitest.workspace.mts` 가 같은 경로를 `tests/helpers/sql-wasm.ts` 로 돌려
     같은 바이트를 같은 모양으로 내놓는다.
2. **상태 DB 경로는 볼트 루트에서 만든다.** `join(basePath, STATE_DB_PATH)`. 설정 폴더 이름을 쓰지 않는다.
3. **릴리스는 세 파일이다.** `release.yml` 이 세 파일을 확인하고 올린다. ADR-006 의 「WASM 파일 플러그인
   디렉토리에 동봉」은 이 ADR 이 대신한다.

## 선택지

| 선택지                                  | 판단                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| wasm 을 네 번째 파일로 두고 경로만 고침 | `Vault#configDir` 로 경로는 고쳐진다. 디렉터리 · BRAT 설치는 여전히 세 파일만 받는다                                       |
| 첫 실행에 wasm 을 내려받음              | 네트워크 없는 첫 실행이 실패한다. 받은 파일을 믿을 근거를 따로 만들어야 한다                                               |
| asm.js 빌드(`sql-asm-memory-growth`)    | 파일 하나로 끝나지만 1.8 ~ 3.6배 느리다(띄우기는 6배, 아래). 번들 크기는 비슷하고, 디렉터리 검사의 wasm 경고도 똑같이 뜬다 |
| **wasm 을 binary 로더로 main.js 에**    | 세 파일 · 공식 빌드 그대로 · 가장 빠르다 — **고른 것**                                                                     |

벤치마크(Node 22, 행 2만 · 노트 경로 · 해시 · 본문 400자, 세 번 잰 가운데 값, ms)

| 빌드   | 띄우기 | 넣기 2만 | 읽기 5천 | 고치기 2천 | 내보내기 | 다시 열기 |
| ------ | -----: | -------: | -------: | ---------: | -------: | --------: |
| wasm   |      5 |      120 |       58 |         47 |        4 |         4 |
| asm.js |     31 |      300 |      104 |        170 |        5 |         6 |

## 남은 한계

- 디렉터리 검사의 번들 사전 점검은 main.js 속 wasm 머리(`AGFz…`)를 «인라인 wasm» 경고로 낸다. 오류가 아니고,
  asm.js 빌드로 바꿔도 같은 경고가 뜬다(실측). 리뷰에서 물으면 이 ADR 로 답한다.
- 예전 릴리스(v0.3.2 까지)로 설치한 폴더에는 `sql-wasm.wasm` 이 남는다. 읽지 않으므로 지워도 된다(README).

## 트레이드오프

- **main.js 가 커진다.** 888KB → 1.79MB. base64 로 실려 wasm 644KB 보다 크다. 디렉터리 · BRAT 의 내려받기는 한
  번이고, 켤 때 읽는 시간은 격리 Obsidian 에서 체감되지 않았다(재지 않음).
- sql.js 를 올리면 같은 이름의 wasm 이 함께 바뀐다. 글루와 wasm 이 같은 패키지에서 오므로 따로 맞출 일은 없다.

## 영향

- 수정
  - `obsidian-plugin/esbuild.config.mjs` — `.wasm` binary 로더. wasm 복사 제거
  - `obsidian-plugin/src/main.ts` — 엔진을 넘김. `.obsidian` 경로 · `require("fs")` 제거
  - `obsidian-plugin/src/constants.ts` — `WASM_FILE` 제거
  - `obsidian-plugin/src/sql.js.d.ts` · `state/sqljs-state-db.ts` — `wasmBinary` 가 `Uint8Array` 도 받음
  - `obsidian-plugin/vitest.workspace.mts` · `tests/helpers/sql-wasm.ts`
  - `.github/workflows/release.yml` — 세 파일
- 상태 DB 파일 · 설정 · 공개 API 는 바뀌지 않았다.

## 검증

- 시험
  - `main.test.ts` — 엔진은 main.js 에 실린 wasm 이고 머리가 `\0asm` 이다. 고치기 전 빨간불(ENOENT, 13개 실패)
  - `sqljs-state-db-open.test.ts` — 실린 바이트(`Uint8Array`)로 실제 엔진을 띄워 저장한 파일을 그대로 읽는다
- 변이 시험 6건 모두 잡힘 — 엔진을 안 넘김 · 다른 바이트 · DB 경로를 볼트 루트에서 안 만듦 · versions 누락 ·
  manifest 사본이 다름 · binary 로더 제거(빌드 실패)
- 라이브(격리 Obsidian, 시험 볼트 `__p4` 를 새 창으로)

  | 앱     | 설정 폴더   | 빌드         | 플러그인 폴더 | 결과                               |
  | ------ | ----------- | ------------ | ------------- | ---------------------------------- |
  | 1.13.7 | `.obs-cfg`  | dev(네 파일) | 네 파일       | ENOENT `.obsidian/…/sql-wasm.wasm` |
  | 1.13.7 | `.obsidian` | dev(네 파일) | 세 파일       | ENOENT 같은 경로                   |
  | 1.13.7 | `.obs-cfg`  | 이 브랜치    | 세 파일       | 준비됨 · 상태 DB 열림              |
  | 1.13.7 | `.obsidian` | 이 브랜치    | 세 파일       | 준비됨 · 상태 DB 열림              |
  | 1.12.4 | `.obsidian` | 이 브랜치    | 세 파일       | 준비됨 · 상태 DB 열림              |
  | 1.12.4 | `.obs-cfg`  | 이 브랜치    | 세 파일       | 준비됨 · 상태 DB 열림              |
  - 1.13.7 `.obs-cfg` 에서 메타 한 줄을 쓰고 플러그인을 껐다 켜 다시 읽었다. `sync.db` 110KB,
    `integrity_check` ok.
  - 1.12.4 는 가짜 토큰으로 상태 DB 를 여는 데까지만 봤다. Notion 에는 닿지 않았다.
