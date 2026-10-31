# ADR-050: 볼트 경로의 유니코드 정규화와 대소문자

> 상태: 승인
> 결정일: 2026-10-31
> 「Notion API 한계를 빼고 모두 동기화」 계획의 P9(플랫폼). macOS · Windows 의 파일 시스템이 Linux 와 다르게 이름을 다루는 데서 오는
> 것을 한 기준으로 맞춘다

## 맥락

같은 이름이 파일 시스템마다 다른 글자열이 된다.

- **NFD** — macOS(APFS · HFS+)에서 만든 한글 · 악센트 이름은 디스크에 풀어 쓴 꼴(NFD)로 남는 일이 많다. 볼트를 동기화
  서비스 · git 으로 옮기면 Linux 에서도 NFD 이름 그대로 온다. 사람이 친 위키링크와 Notion 제목은 NFC 다
- **대소문자** — macOS · Windows 의 기본 파일 시스템은 대소문자를 가리지 않는다. Notion 은 `Note` 와 `note` 를 다른 두
  페이지로 둔다

실측(2026-10-31 · 0.15.0 · NFD 볼트):

- push 가 NFD 제목의 페이지를 만들었다 — 「회의」 로 검색해도 찾지 못하고, NFC 로 친 `[[회의]]` 는 그 페이지를 잇지 못했다
- pull 이 Notion 에서 고친 글을 NFC 이름의 **새 파일** 에 썼다 — macOS 에서는 같은 파일, Linux 에서는 한 폴더에 같아 보이는 두 이름
- `Note` · `note` 두 페이지를 받으면 대소문자를 가리지 않는 디스크에서 한 파일이 다른 하나를 덮었다 — 오류는 없었다

## 선택지

1. 디스크 이름을 그대로 볼트 경로로 쓴다(지금) — 위의 셋이 남는다
2. 디스크의 NFD 파일을 NFC 이름으로 바꾼다 — 사용자의 파일 이름을 바꾸고, 그 볼트를 함께 쓰는 다른 기기 · 동기화 서비스가 두 이름을 보게 된다
3. **볼트 경로는 늘 NFC 로 보고 디스크 이름은 그대로 둔다. 대소문자는 «이미 그 자리에 다른 노트가 있다» 로 본다**

## 결정

3 을 택한다.

**NFC 볼트 경로.** `NodeVaultFS` 가 디스크를 걸을 때 NFC 경로 → 디스크 경로를 적고, 읽기 · 쓰기 · 옮기기 · 지우기는 그 디스크
경로로 한다. 걷기 전에 부른 경로는 부모 폴더를 읽어 NFC 꼴이 같은 이름을 찾는다(비 ASCII 일 때만). 한 폴더에 NFC 와 NFD 가
글자 그대로 둘 다 있으면 NFD 쪽은 제 이름을 경로로 쓴다 — 서로를 읽지 않는다. 새 파일은 NFC 로 만든다(`sanitizeFileName`).
위키링크 조회도 NFC 로 견준다.

**옛 기록 옮기기.** 0.15 이하가 NFD 로 적은 상태 기록 · 파일 기록 · DB 폴더는 명령이 처음 열릴 때 NFC 로 고친다(`paths_nfc_v1`).
NFC 자리를 다른 기록이 이미 들고 있으면 그 기록은 두고 경고한다. Notion 에 이미 있는 NFD 제목은 바꾸지 않는다 — 다시 쓰면
사용자가 Notion 에서 고친 것과 겨룬다.

**대소문자.** 받을 자리를 고를 때 `pathKey = NFC + 소문자` 로 견준다. 같은 키를 다른 페이지가 이미 들고 있으면(이번 받기에서
잡았거나 상태 기록에 있으면) 그 자리는 남의 것으로 보고, 지금까지 이름이 겹칠 때처럼 id 를 붙여 받는다. 상태 DB 는
`COLLATE NOCASE` 색인으로 찾는다(스키마 5).

## 이유

- 사용자의 디스크 이름을 바꾸지 않는다 — 되돌릴 수 없는 일을 하지 않고도 셋을 모두 막는다
- 대소문자를 가리는 Linux 에서도 같은 규칙을 쓴다 — 한 볼트를 macOS 와 Linux 가 함께 쓸 때 어느 쪽에서 받아도 같은 이름이 된다
- `COLLATE NOCASE` 는 ASCII 만 접는다. 한글에는 대소문자가 없고, ASCII 밖의 대소문자(독일어 · 그리스어)는 키를 견주는
  코드가 맞춘다 — 색인은 후보를 좁히는 데만 쓴다

## 트레이드오프

- Linux 에서 `Note.md` 와 `note.md` 를 둘 다 둔 볼트도 두 번째를 id 붙인 이름으로 받는다(대소문자를 가리지 않는 기기로
  옮겨도 깨지지 않게)
- 이름의 대소문자만 바꾼 Notion 제목(`note` → `Note`)은 같은 페이지의 자리라 그대로 이름을 바꾼다
- NFD 이름을 찾으려고 부모 폴더를 한 번 더 읽는다(비 ASCII 이름이고 걷기 전에 부를 때만)
- 터키어 ı/İ 같은 언어별 접기는 하지 않는다 — `toLowerCase()` 만 쓴다

## 영향

- `node-vault-fs.ts` — `entriesOf` · `onDisk` · `full` · `forget`
- `nfc-paths.ts` `upgradeNfcPaths` · `note-relocation.ts` `rewriteRecorded` · `orchestrator.ts` `alignStatePaths`
- `utils/path-key.ts` `pathKey` · `foldedOwnerOf` · `IStateDB.getByPathKey`(core · 플러그인 sql.js)
- `page-puller.ts` `claimFilePath` · `database-syncer.ts` · `database-discovery.ts` — 키로 자리 견주기
- 마이그레이션 `005-path-nocase.ts`
- CI 에 macOS 작업 — APFS 에서 NFD · 대소문자 시험이 실제로 돈다
- 시험: `tests/sync/unicode-paths.test.ts` · `tests/sync/case-fold-paths.test.ts` · `node-vault-fs.test.ts` 「NFD 이름」
