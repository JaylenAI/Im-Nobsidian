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
  },
  "sync": {
    "direction": "both", // "push" | "pull" | "both"
    "conflictStrategy": "manual", // "local-first" | "remote-first" | "manual" | "duplicate"
    "autoSync": false, // watch 모드 시 자동 동기화
    "autoSyncInterval": 300, // 자동 동기화 간격 (초)
    "deleteSync": false, // 삭제 동기화 여부
  },
  "paths": {
    "include": ["**/*"], // 동기화 포함 glob 패턴
    "exclude": [], // 동기화 제외 glob 패턴
    "attachments": "attachments", // 이미지 다운로드 폴더
  },
  "conversion": {
    "preferMarkdownApi": true, // Notion Markdown API 사용 (권장)
    "preserveMarkers": true, // 보존 마커 활성화
    "frontmatterMapping": true, // 프론트매터 ↔ 속성 매핑
    "imageDownload": "immediate", // "immediate" | "lazy"
  },
  "advanced": {
    "concurrency": 3, // 동시 API 요청 수
    "maxRetries": 5, // API 재시도 횟수
    "timeoutMs": 30000, // API 타임아웃 (ms)
    "batchSize": 100, // 배치 처리 크기
  },
}
```

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
- `"database"` — 마크다운 파일이 데이터베이스 행으로 동기화됩니다

## Sync Settings / 동기화 설정

### direction

- `"both"` — 양방향 동기화 (Pull → Push, 기본값)
- `"push"` — Obsidian → Notion만
- `"pull"` — Notion → Obsidian만

### conflictStrategy

양쪽에서 같은 파일을 수정했을 때 해결 전략:

- `"local-first"` — 항상 Obsidian 버전 유지
- `"remote-first"` — 항상 Notion 버전 유지
- `"manual"` — 충돌 마커 삽입 후 수동 해결 (기본값)
- `"duplicate"` — 양쪽 버전을 모두 보존 (`.conflict` 파일 생성)

### deleteSync

- `false` (기본값) — 삭제는 동기화하지 않음 (안전)
- `true` — 한쪽에서 삭제 시 반대쪽에서도 삭제

## Path Settings / 경로 설정

### include / exclude

glob 패턴으로 동기화 범위를 제한합니다:

```jsonc
{
  "paths": {
    "include": ["projects/**", "notes/**"],
    "exclude": ["templates/**", "daily/**", "*.excalidraw.md"],
  },
}
```

### .im-nobsidian-ignore

볼트 루트에 `.im-nobsidian-ignore` 파일을 생성하면 `.gitignore`와 동일한 문법으로 파일을 제외할 수 있습니다:

```
# 템플릿 폴더 제외
templates/

# Excalidraw 파일 제외
*.excalidraw.md

# 비공개 노트
private/
```

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
`false`: 레거시 Block API + notion-to-md를 사용합니다.

### preserveMarkers

`true` (기본값): Obsidian 고유 문법 (콜아웃 타입, 토글 상태 등)을 보존 마커로 저장합니다.
이를 통해 Push → Pull 왕복 시 원본 문법이 완벽하게 복원됩니다.

### frontmatterMapping

`true` (기본값): YAML 프론트매터 ↔ Notion 속성을 자동 매핑합니다.
지원 타입: title, rich_text, number, select, multi_select, date, checkbox, url, email, phone_number, people, status, created_time, last_edited_time, formula, relation, files

## Advanced Settings / 고급 설정

### concurrency

동시 API 요청 수. Notion rate limit (3 req/s) 이내로 설정하세요.

### maxRetries

API 실패 시 재시도 횟수. 지수 백오프 + 랜덤 지터가 적용됩니다.

### timeoutMs

단일 API 요청의 타임아웃 (밀리초). 대규모 페이지의 경우 증가가 필요할 수 있습니다.

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
