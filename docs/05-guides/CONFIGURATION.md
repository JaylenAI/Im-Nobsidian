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
    "conflictStrategy": "manual", // "ask" | "local-wins" | "remote-wins" | "manual"
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
    "batchSize": 50, // 배치 처리 크기
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

- `"ask"` — CLI에서 매번 물어봄
- `"local-wins"` — 항상 Obsidian 버전 유지
- `"remote-wins"` — 항상 Notion 버전 유지
- `"manual"` — 충돌 마커 삽입 후 수동 해결

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
