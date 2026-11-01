# Configuration / 설정 가이드

`nobsi init` 실행 후 `.im-nobsidian/config.json`에 설정 파일이 생성됩니다.

## Config Schema / 설정 스키마

```jsonc
{
  "version": 1,
  "notion": {
    "token": "ntn_...", // Notion Integration Secret
    "rootPageId": "...", // 루트 페이지 또는 데이터베이스 ID
    "parentMode": "page", // "page" (페이지 트리) 또는 "database" (DB 행)
    "databases": [], // 따로 받을 DB — [{ "databaseId": "...", "localFolder": "Tasks" }]
  },
  "sync": {
    "direction": "both", // "push" | "pull" | "both"
    "conflictStrategy": "manual", // "local-first" | "remote-first" | "manual" | "duplicate" | "merge"
    "autoSync": false, // nobsi watch 의 주기 동기화
    "autoSyncInterval": 300, // 주기 동기화 간격 (초, 30–3600)
    "fullReconcileInterval": 3600, // Notion 전체 확인 주기 (초, 0 = pull 마다)
    "deleteSync": false, // 삭제 동기화 여부
    "renameOnTitleChange": false, // Notion 에서 바꾼 제목으로 파일 이름 바꾸기
    "syncFiles": true, // 볼트 첨부를 폴더 페이지에 올리기
    "createDatabases": true, // DB 정의 파일이 있는 폴더를 Notion DB 로 만들기
    "notifications": "silent", // "silent" | "default"
  },
  "paths": {
    "include": ["**/*"], // 동기화 포함 glob 패턴
    "exclude": [], // 동기화 제외 glob 패턴
    "excludeObsidianOnly": true, // Canvas · Excalidraw · 템플릿 폴더 빼기
    "attachments": "attachments", // 받은 그림 · 파일을 두는 폴더
  },
  "conversion": {
    "preferMarkdownApi": true, // Notion Markdown API 사용 (권장)
    "imageDownload": "immediate", // "immediate" | "skip" ("lazy" 는 "skip" 과 같다)
    // "timeZone": "Asia/Seoul", // DB 날짜시각의 시간대 — 없으면 이 컴퓨터의 시간대
  },
  "advanced": {
    "concurrency": 3, // 동시에 기다리는 API 요청 수
    "rateLimitIntervalMs": 350, // 요청 사이 최소 간격 (ms)
    "maxRetries": 5, // API 재시도 횟수
    "timeoutMs": 30000, // API 타임아웃 (ms)
    // 그 밖의 값은 아래 「Advanced Settings」 — 보통 바꿀 일이 없다
  },
}
```

설정 파일에 적지 않은 키는 기본값을 씁니다. 0.16 부터 없앤 키(`conversion.preserveMarkers` · `conversion.frontmatterMapping`
· `notion.workspaceId` · `notion.databases[].propertyMapping` · `notion.databases[].titleProperty`)는 읽을 때 버립니다 — 어느
것도 동작을 바꾼 적이 없었습니다. 기본값과 다른 값을 적어 두었으면 그렇다고 알립니다.

## Notion Settings / Notion 설정

### token

Notion Integration Secret. `ntn_`로 시작합니다.
[notion.so/my-integrations](https://www.notion.so/my-integrations)에서 생성합니다.

### rootPageId

동기화 루트로 사용할 Notion 페이지 또는 데이터베이스의 ID.
Notion 페이지 URL에서 마지막 32자리 (하이픈 제외):

```
https://www.notion.so/My-Page-abc123def456...
                              ^^^^^^^^^^^^^^^^ 이 부분
```

### parentMode

- `"page"` — 마크다운 파일이 페이지 트리로 동기화됩니다 (기본값)
- `"database"` — 마크다운 파일이 데이터베이스 행으로 동기화됩니다. `notion.databaseId` 도 적어야 합니다 — 없으면
  페이지 모드로 동작합니다. `nobsi init` 은 이 둘을 묻지 않으므로 `config.json` 에 직접 적습니다.

### databases

루트 아래가 아닌 곳의 DB 를 볼트의 폴더로 받습니다. 줄마다 `databaseId` · `localFolder`(볼트 루트 기준 폴더), 그리고 받을 행만
고르는 `pullFilter`(Notion API 의 [필터 객체](https://developers.notion.com/reference/post-database-query-filter) 그대로)를 적습니다.

```jsonc
{
  "notion": {
    "databases": [
      {
        "databaseId": "1fa13b18d38280cf9057e37e6e473e41",
        "localFolder": "Projects/Tasks",
        "pullFilter": { "property": "Status", "status": { "does_not_equal": "Done" } },
      },
    ],
  },
}
```

`pullFilter` 가 있는 DB 는 지운 행을 반대쪽에서 지우지 않습니다 — 필터 밖으로 나간 행과 지운 행을 가를 수 없기 때문입니다.
루트 아래의 DB 는 여기 적지 않아도 찾아서 받습니다. 플러그인은 설정의 **Notion DB** 절입니다.

## Sync Settings / 동기화 설정

### direction

- `"both"` — 양방향 동기화 (Pull → Push, 기본값)
- `"push"` — Obsidian → Notion만
- `"pull"` — Notion → Obsidian만. 충돌을 풀어도 결과를 Notion 에 올리지 않습니다 — 고른 것은 Obsidian 에만
  남고, 그 뒤의 Notion 편집은 다시 받습니다

### conflictStrategy

양쪽에서 같은 파일을 수정했을 때 해결 전략:

- `"local-first"` — 항상 Obsidian 버전 유지
- `"remote-first"` — 항상 Notion 버전 유지
- `"manual"` — 충돌로 표시하고 노트는 그대로 둔다 — `nobsi resolve` · 플러그인 사이드바에서 고른다 (기본값)
- `"merge"` — 서로 다른 줄을 고쳤으면 지난 동기화 사본을 공통 조상으로 3-way 병합해 볼트에 쓰고(sync 는 같은 실행에서
  Notion 에 올린다 · pull 은 다음 push 가 올린다), 같은 줄을 고쳤으면 manual 처럼 충돌로 남긴다. 노트에 충돌 표시를
  넣지 않는다. 플러그인 설정의 「다른 줄을 고친 충돌은 합치기」
- `"duplicate"` — 양쪽 버전을 모두 보존 (`노트.conflict.md` 사본 생성 — 이 사본은 Notion 에 올리지 않습니다.
  올리려면 이름을 바꾸세요)

### deleteSync

- `false` (기본값) — 삭제는 동기화하지 않음 (안전)
- `true` — 한쪽에서 삭제 시 반대쪽에서도 삭제 — 노트 · DB 행과 폴더 첨부(`syncFiles`) 모두

어느 쪽이든 Notion 에서 지운 페이지(휴지통 · 보관)의 노트를 고쳐 push 하면 올리지 않고 충돌로 남깁니다. 충돌
해결에서 로컬 유지(Notion 에 새 페이지로 다시 만들기)나 삭제 따르기(Obsidian 파일도 지우기)를 고르세요.

### renameOnTitleChange

- `false` (기본값) — Notion 에서 바꾼 제목은 노트 frontmatter 의 `title:` 로 받고 파일 이름은 둔다
- `true` — 파일 이름을 새 제목으로 바꾸고(같은 이름이 있으면 새 페이지를 받을 때처럼 `(id8)` 을 붙인다), 그 노트를
  가리키던 다른 노트의 위키링크 · 임베드 · 마크다운 링크를 고친다. 노트 옆의 자식 폴더 · 폴더 노트의 폴더 · DB 행의
  하위 페이지 폴더도 함께 바꾼다

이름을 바꾸지 않는 경우 — frontmatter `title:` 을 파일 이름과 따로 정해 두었거나, 그 노트의 제목을 볼트에서도 고쳤거나,
볼트에서 옮긴 것을 아직 올리지 않았거나, 폴더 안에 DB · 다른 연결 폴더가 있으면 예전처럼 제목만 받는다(ADR-040).
플러그인은 설정의 「Notion 에서 바꾼 제목으로 이름 바꾸기」 다.

### autoSync / autoSyncInterval

- `autoSync: true` — `nobsi watch` 가 파일 변경 때 말고도 `autoSyncInterval` 초마다(30–3600, 기본 300) 볼트 전체를 동기화합니다
- `nobsi watch --interval <초>` 를 주면 그 값이 이깁니다(`0` 은 끔)

0.17.1 전까지는 이 두 값을 아무도 읽지 않았습니다. 플러그인은 설정 탭의 「자동 동기화」 를 씁니다.

### fullReconcileInterval

Notion 전체를 훑어 확인하는 주기(초, 기본 3600, 0–604800). 그 사이의 pull 은 바뀐 페이지 · 행 · DB 만 받고, Notion 에서 지운
페이지는 pull 마다 15개씩 돌아가며 확인합니다(ADR-027 · 044). `0` 이면 pull 마다 전체를 봅니다. `nobsi pull --force` 는 주기와
상관없이 지금 전체를 봅니다.

### syncFiles

`true`(기본값) — 노트에 붙이지 않고 폴더에 둔 파일(폴더 첨부)을 그 폴더의 Notion 페이지에 파일 블록으로 올리고, 다른 볼트는 같은
폴더에 같은 이름으로 받습니다(ADR-054). 노트 없는 폴더면 폴더 페이지를 만듭니다. 바뀐 파일은 블록을 바꾸고, 바뀌지 않은 파일은 다시
올리지 않습니다. 노트에 붙인 첨부(`![[파일]]` · frontmatter `icon` · `cover`)는 이 값과 상관없이 그 노트와 함께 올라갑니다.

올리지 않는 것 — 받은 첨부 폴더(`paths.attachments`, 받은 것을 다시 올려 겹치지 않게) · 점으로 시작하는 폴더 · 폴더 노트가 있는
폴더와 볼트 맨 위의 파일(push 때 경고로 알립니다 — 노트에 붙이면 함께 올라갑니다) · Notion 이 받지 않는 형식(`.ipynb` 등, push 때
알립니다). 지운 폴더 첨부는 `deleteSync` 가 켜져 있으면 다른 쪽에서도 지웁니다 — 볼트에서 고친 파일은 지우지 않고 다시 올립니다.

### createDatabases

`true`(기본값) — DB 정의 파일(`<폴더>.notion.json` 사이드카)이 있는 새 폴더를 push 가 Notion DB 로 만들고 그 안의 노트를 행으로
올립니다(ADR-036 · 037). `false` 면 그 폴더를 보통 폴더 페이지로 올립니다.

### notifications

- `"silent"`(기본값) — 동기화가 만들고 고친 페이지가 페이지 수정 · @멘션 · 사람 속성 알림을 보내지 않습니다. 볼트를 새
  워크스페이스로 올릴 때 사람 속성이 있는 행마다 그 사람에게 알림이 가던 것을 막습니다
- `"default"` — Notion 의 기본 동작대로 알립니다

## Path Settings / 경로 설정

### include / exclude

glob 패턴으로 동기화 범위를 제한합니다. 플러그인은 설정의 「동기화 범위」 에 같은 패턴을 한 줄에 하나씩 적습니다(0.11):

```jsonc
{
  "paths": {
    "include": ["projects/**", "notes/**"],
    "exclude": ["templates/**", "daily/**", "*.excalidraw.md"],
  },
}
```

패턴 규칙(0.9.2):

| 패턴                                        | 맞는 것                                                              |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `templates` · `templates/` · `templates/**` | 그 폴더와 안의 모든 것                                               |
| `notes/**/*.md`                             | `notes` 안의 모든 노트 — 바로 아래 노트도(`**/` 는 폴더 0 단계 이상) |
| `*.excalidraw.md` · `draft-*` (`/` 없음)    | 어느 깊이에서나 그 이름의 파일 · 폴더                                |
| `Archive/*` (`/` 있음)                      | 볼트 맨 위부터 — `Archive` 바로 아래 것과 그 안                      |

- 경로는 볼트 기준이고 `/` 로 씁니다. Windows 에서 `\` 로 써도 같습니다
- 포함 패턴은 파일에 댑니다 — 폴더를 걸러 내지 않습니다. 제외가 포함보다 이깁니다
- 동기화하던 노트를 나중에 빼면 그 노트는 그대로 둡니다 — Notion 페이지를 지우지 않고, 「삭제됨」 으로 보이지 않으며,
  pull 이 받거나 되살리지 않습니다. 이미 받은 DB 의 폴더를 빼면 그 DB 를 받지 않습니다
- Notion 에 새로 생긴 페이지가 뺀 자리(폴더 · 이름)에 놓일 것이면 받지 않습니다 — `pull` · `status --full` 이 그 자리를
  알립니다
- 경로는 연결 폴더 기준입니다. 볼트 안 폴더 연결(ADR-038)은 그 폴더 기준으로 따로 적고, 볼트 연결의 패턴은 폴더
  연결에 대지 않습니다

### excludeObsidianOnly

- `true` (기본값) — Obsidian 에서만 쓰는 것을 동기화하지 않습니다. Notion 에서 그릴 수도 쓸 수도 없습니다
  - Canvas(`*.canvas`) · Excalidraw(`*.excalidraw.md` · `*.excalidraw`) — 안은 JSON 입니다
  - 템플릿 폴더 — Obsidian 의 「템플릿」(`.obsidian/templates.json` 의 `folder`) · Templater(`templates_folder`) 설정에서
    읽습니다. 폴더 연결이 템플릿 폴더 자신이거나 그 안이면 빼지 않습니다
- `false` — 다른 파일처럼 올립니다

이미 동기화한 것을 빼도 위의 제외 패턴처럼 Notion 페이지는 지우지 않습니다. 플러그인은 설정의 「Obsidian 에서만 쓰는 것은
빼기」 다(모든 연결에 같다).

### .im-nobsidian-ignore

볼트 루트(폴더 연결이면 그 폴더)에 `.im-nobsidian-ignore` 파일을 생성하면 한 줄에 패턴 하나로 파일을 제외할 수
있습니다. CLI 와 플러그인이 같이 읽습니다(플러그인은 다시 연결할 때 읽습니다). 규칙은 위
`exclude` 와 같습니다(`#` 로 시작하는 줄은 주석, `!` 부정 패턴은 없습니다):

```
# 템플릿 폴더 제외
templates/

# Excalidraw 파일 제외
*.excalidraw.md

# 비공개 노트
private/
```

뺀 자리에 놓일 Notion 의 새 페이지(뺀 폴더 아래에 만든 페이지 · 포함 패턴 밖의 페이지)는 받지 않습니다 — 받으면
사용자가 뺀 폴더에 파일이 생기고, 그 노트는 다시 올라가지 않습니다. `pull` 은 받지 않은 페이지를 경로로 알리고(JSON
`excluded`), `status --full` 은 원격 변경과 따로 「New in Notion, not pulled」 로 보입니다. 플러그인은 알림으로 알립니다.

### attachments

Pull 시 이미지가 저장될 폴더명. 볼트 루트 기준 상대 경로입니다.

```jsonc
{
  "paths": {
    "attachments": "attachments", // → vault/attachments/image.png
  },
}
```

## Conversion Settings / 변환 설정

### preferMarkdownApi

`true` (기본값): Notion 공식 Markdown API를 사용합니다. 변환 품질이 높습니다.
`false`: 블록 API 로 블록을 읽고 씁니다. 받은 블록은 Markdown API 와 같은 NFM 으로 옮긴 뒤 같은 변환을 거칩니다
(ADR-034 · 035). 블록 API 가 주지 않는 것(콜아웃 첫 줄 아래 자식, 표 열 너비 · 행 색, 지역 시간대 이름)은 잃습니다.
바뀌지 않은 미디어도 매번 다시 올리고, 자식 페이지 · DB 가 있는 페이지의 본문은 보내지 않습니다(자식까지 지워지므로).

`true` 여도 Markdown API 로 받지 못한 페이지는 블록 API 로 받습니다.

### imageDownload

- `"immediate"`(기본값) — pull 때 Notion 에 올린 그림을 `attachments` 폴더로 받아 노트에 `![[…]]` 로 적습니다
- `"skip"` — 받지 않고 Notion 의 주소를 그대로 적습니다. Notion 에 올린 파일의 주소는 **약 1시간 뒤 열리지 않습니다**
- `"lazy"` — 지금은 `"skip"` 과 같습니다(나중에 받는 동작은 없습니다)

파일 블록(PDF · 첨부)은 이 값과 상관없이 받습니다(`maxFileSizeBytes` 까지). 플러그인은 설정의 「Notion 의 그림 받기」 입니다.

### timeZone

DB 의 날짜시각 속성을 적고 보낼 시간대(IANA 이름, 예: `"Asia/Seoul"`). 없으면 이 컴퓨터의 시간대입니다. Obsidian 의 날짜시각
속성에는 시간대가 없어서, pull 은 이 시간대의 시각으로 적고 push 는 이 시간대의 오프셋을 붙여 보냅니다.

### preserveMarkers · frontmatterMapping (0.16 에 없앰)

둘 다 꺼도 동작이 바뀌지 않았습니다. Notion 이 받지 못하는 기능은 늘 보존 마커로 남기고, frontmatter 는 늘 Notion 속성으로
주고받습니다. 적어 두었으면 지워도 됩니다.

## Advanced Settings / 고급 설정

### concurrency

동시에 응답을 기다리는 요청 수(기본 3) — 느린 요청 하나 뒤에 다른 요청이 줄 서지 않게 합니다. 요청이 **나가는 빠르기**는
`rateLimitIntervalMs` 가 정합니다. 칸을 늘려도 초당 요청 수는 늘지 않습니다(0.16 부터 — 그 전에는 칸 수만큼 한꺼번에 나가
기본값이 초당 8회 남짓이 되었고, 큰 볼트의 첫 동기화가 429 를 거듭 맞았습니다).

### rateLimitIntervalMs

요청이 나가는 최소 간격(ms, 기본 350 — 분당 약 171회). Notion 의 한도는 2026-09-09 부터 60초 고정 창에 Business · Enterprise
분당 600회, 그 밖의 플랜 분당 180회입니다. 기본값은 모든 플랜에 맞춘 값입니다. Business 이상 워크스페이스라면 `120`(분당 500회)
쯤으로 낮춰 큰 볼트의 첫 동기화를 줄일 수 있습니다 — Business 워크스페이스에서는 실측하지 않았습니다. 429 가 자주 보이면 이
값을 올리세요.

### maxRetries · retryBaseDelayMs · retryBackoffFactor

API 실패 시 재시도 횟수(기본 5, 0–10)와 그 사이 대기. 대기는 `retryBaseDelayMs × retryBackoffFactor^시도` 에 0.5–1.0 배 지터를
곱한 값입니다(기본 1000ms · 2). 서버가 `Retry-After` 를 주면 그 시간(1.0–1.25 배)을 기다리고, 429 는 모든 요청이 함께 멈춥니다.

### timeoutMs

단일 API 요청의 타임아웃 (밀리초). 대규모 페이지의 경우 증가가 필요할 수 있습니다.

### retryWaitMs

한 번의 push · pull 안에서 실패한 노트를 다시 해 보기 전에 기다리는 시간(ms, 기본 2000, 0–30000). 다시 해도 실패한 노트는 결과의
실패로 남고 다음 동기화가 다시 합니다.

### pageSize · batchSize

목록을 한 번에 읽는 수와 블록을 한 번에 붙이는 수(기본 100 — Notion 의 상한). 낮추면 요청 수가 늘어납니다.

### mediaConcurrency · mediaMaxRetries · mediaRetryBaseMs · fileConcurrency

그림 · 미디어를 동시에 받는 수(기본 3), 받기 시도 수(기본 3, 0 은 1 로 본다)와 다시 받기 전 대기(기본 1000ms × 몇 번째 재시도인지), 첨부를 동시에 올리고
받는 수(기본 2). 모두 최대 10. 늘려도 API 요청 빠르기는 `rateLimitIntervalMs` 가 정합니다.

### maxFileSizeBytes

Pull 시 다운로드할 파일(비디오·첨부 등)의 크기 상한. 기본 **100MB** (`104857600`).

상한을 초과하는 파일은 다운로드하지 않고 **Notion 원본 링크를 노트에 유지**합니다
(의도된 degrade — 로그에 `크기 상한 초과`로 표시). 링크는 안정 식별자 기반이라
재 pull 에도 변하지 않으며, push 시에는 원본 블록이 그대로 보존됩니다.
대용량 강의 영상 등까지 볼트에 내려받으려면 이 값을 늘리세요:

```json
{
  "advanced": { "maxFileSizeBytes": 2147483648 }
}
```

### mediaDownloadTimeoutMs

미디어·첨부 **다운로드 1회 시도**의 시간 상한 (밀리초). 기본 **300초** (`300000`).

`timeoutMs`(API 요청 타임아웃)와 별개입니다. 파일 본문 스트림까지 덮으므로, 응답이
오다 멈춘 연결(만료된 프리사인 URL·중간 프록시 끊김)에서도 동기화가 그 자리에 멎지 않고
해당 파일만 실패로 처리되고 다음으로 넘어갑니다. 기본값은 상한 파일 크기(100MB)를
초당 340KB로도 받아낼 수 있는 여유값입니다.

느린 회선에서 대용량 첨부가 반복 실패한다면 늘리세요:

```json
{
  "advanced": { "mediaDownloadTimeoutMs": 900000 }
}
```

`0`으로 두면 상한이 사라집니다 — 한 파일이 동기화 전체를 멈춰 세울 수 있어 권장하지 않습니다.

### itemTimeoutMs

**페이지 1건 전체 처리**의 시간 상한 (밀리초). 기본 **30분** (`1800000`).

한 페이지를 처리하는 경로는 API 호출 수십 개와 변환·파일 IO가 얽힌 합성 작업입니다.
그중 어느 하나가 끝나지 않으면 워커 슬롯이 묶이고, 슬롯이 모두 묶이면 진행 로그까지
멈춥니다. 이 상한은 그 무한 정지를 **유한한 실패**로 바꿉니다 — 해당 페이지만 실패로
끊어 재시도·실패 보고 경로에 태우고, 나머지 페이지는 계속 진행합니다.

기본값은 정상 페이지가 절대 닿지 않을 만큼 넉넉하게 잡혀 있습니다(정상 페이지는 초 단위).
매우 느린 회선에서 대용량 첨부가 많은 페이지가 걸린다면 늘리세요:

```json
{
  "advanced": { "itemTimeoutMs": 3600000 }
}
```

`0`으로 두면 상한이 사라집니다(기존 동작). 한 페이지가 동기화 전체를 영구히 멈춰 세울 수
있으므로 권장하지 않습니다.

### markdownCompletionMaxBlocks

Notion Markdown API 가 **잘라 보낸 블록**을 다시 받아 채우는 수의 상한. 기본 **3,000개**.

블록이 아주 많은 페이지(실측: 약 2만 블록 이후)는 Markdown API 가 뒤쪽 블록을 자리표시로
바꿔 보냅니다. 동기화는 그 블록들을 하나씩 다시 받아 제자리에 채웁니다 — 채우지 않으면
본문 일부가 빠진 사본이 동기화 완료로 기록됩니다. 블록 하나에 요청 하나가 들기 때문에,
기본 요청 간격(350ms)으로 3,000개는 약 17분이고 `itemTimeoutMs`(30분) 안에서 끝납니다.

상한을 넘는 페이지는 블록 API 로 받습니다(일반 페이지는 Markdown API). 이때 로그에
「Markdown API 로 받지 못해 블록 API 로 받음」이 남습니다. DB 행은 블록 API 경로가 없어
그 행만 실패로 보고되고 다음 pull 에서 다시 시도합니다.

```json
{
  "advanced": { "markdownCompletionMaxBlocks": 6000 }
}
```

권한이 닿지 않는 블록(Notion 이 404 로 답하는 블록)은 다시 받지 못해 자리표시로 남고, push 때
Notion 에 그대로 돌아갑니다. 같은 모양의 북마크 자리표시를 되돌려 보냈을 때 원래 블록이
남는 것은 확인했지만, 권한 없는 블록 자체로는 확인하지 못했습니다.

## Database Mode / 데이터베이스 모드

`parentMode: "database"`로 설정하면 마크다운 파일이 데이터베이스 행으로 동기화됩니다.
프론트매터 필드가 데이터베이스 속성에 직접 매핑됩니다:

```yaml
---
status: In Progress # → Select 속성
tags: [ai, project] # → Multi-select 속성
priority: 1 # → Number 속성
due: 2026-06-30 # → Date 속성
---
```
