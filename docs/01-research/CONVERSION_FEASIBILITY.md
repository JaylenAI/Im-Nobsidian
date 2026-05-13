# 변환 가능성 매트릭스 (100% Sync Fidelity)

> 작성일: 2026-05-08
> 상태: complete
> 원칙: **불가능은 없다** -- 모든 기능은 대안 포맷으로라도 100% 보존

## 설계 원칙

1. **플러그인 없이도 데이터 100% 보존** -- 시각적 표현은 플러그인이 향상(progressive enhancement)
2. **preserve marker** (`%% im-nobsidian:... %%`) 로 라운드트립 복원 보장
3. **전처리/후처리 파이프라인**으로 모든 변환 처리

```
Obsidian MD → [전처리기] → [martian/커스텀] → Notion API
Notion API → [notion-to-md/커스텀] → [후처리기] → Obsidian MD
```

---

## A등급: 완벽 변환 (손실 0%)

| Obsidian          | Notion                  | 방향   | 비고                         |
| ----------------- | ----------------------- | ------ | ---------------------------- |
| `# H1` ~ `### H3` | heading_1/2/3           | 양방향 |                              |
| 일반 텍스트       | paragraph               | 양방향 |                              |
| `**볼드**`        | bold annotation         | 양방향 |                              |
| `*이탤릭*`        | italic annotation       | 양방향 |                              |
| `~~취소선~~`      | strikethrough           | 양방향 |                              |
| `` `코드` ``      | code annotation         | 양방향 |                              |
| `- 리스트`        | bulleted_list_item      | 양방향 |                              |
| `1. 순서`         | numbered_list_item      | 양방향 |                              |
| `- [ ] 할일`      | to_do                   | 양방향 |                              |
| `> 인용`          | quote                   | 양방향 |                              |
| `---`             | divider                 | 양방향 | 위아래 빈 줄 필수            |
| `[텍스트](URL)`   | rich_text href          | 양방향 |                              |
| `$E=mc^2$`        | inline equation         | 양방향 | KaTeX 공통 서브셋            |
| `$$...$$`         | equation block          | 양방향 | KaTeX 공통 서브셋            |
| Mermaid 코드 블록 | code block (mermaid)    | 양방향 | Notion도 mermaid 렌더링 지원 |
| Notion 목차(TOC)  | Obsidian Outline 코어   | 양방향 | preserve marker로 복원       |
| Notion Breadcrumb | 폴더 구조 + frontmatter | 양방향 | 자연스러운 매핑              |

---

## B등급: 대안 포맷 변환 (기능 보존, 형식 차이)

### B-1. 코드 블록

| 방향   | 변환                     | 세부                                  |
| ------ | ------------------------ | ------------------------------------- |
| 양방향 | ` ```lang ` ↔ code block | 언어명 매핑 테이블 (js↔javascript 등) |

### B-2. 콜아웃 ↔ Notion Callout

**Obsidian → Notion 타입 매핑:**

| Obsidian `[!type]`            | Notion Icon | Notion Color      |
| ----------------------------- | ----------- | ----------------- |
| note                          | 📝          | blue_background   |
| info                          | ℹ️          | blue_background   |
| tip / hint                    | 💡          | green_background  |
| important                     | ☝️          | purple_background |
| warning / caution / attention | ⚠️          | yellow_background |
| danger / error                | 🚫          | red_background    |
| success / check / done        | ✅          | green_background  |
| question / help / faq         | ❓          | yellow_background |
| failure / fail / missing      | ❌          | red_background    |
| bug                           | 🐛          | red_background    |
| example                       | 📋          | purple_background |
| quote / cite                  | 💬          | gray_background   |
| abstract / summary / tldr     | 📄          | blue_background   |

**접이식(foldable) 처리:** Notion callout은 접기 미지원 → caption에 메타 보존

```
caption: "im-nobsidian:callout-type:warning:foldable:collapsed"
```

### B-3. 테이블

| 방향   | 변환                   | 세부                     |
| ------ | ---------------------- | ------------------------ |
| 양방향 | MD table ↔ table block | 셀 내 복잡 서식은 단순화 |

### B-4. 프론트매터 ↔ Notion Properties

**타입 매핑:**

| YAML 타입     | 예시                 | Notion Property                    |
| ------------- | -------------------- | ---------------------------------- |
| `string`      | `status: active`     | select 또는 rich_text              |
| `string[]`    | `tags: [a, b]`       | multi_select                       |
| `number`      | `priority: 3`        | number                             |
| `boolean`     | `published: true`    | checkbox                           |
| 날짜 문자열   | `date: 2026-05-08`   | date                               |
| URL 문자열    | `url: https://...`   | url                                |
| wikilink 배열 | `related: ["[[A]]"]` | relation                           |
| 중첩 객체     | `meta: { a: 1 }`     | `_im_nobsidian_meta` (JSON 직렬화) |

**Notion에 매핑 불가한 복잡한 속성:**

```yaml
# Notion 페이지의 _im_nobsidian_meta 속성 (rich_text)에 JSON으로 보존
_im_nobsidian_meta: '{"aliases":["배포 가이드"],"custom_nested":{"a":1}}'
```

### B-5. 태그

| Obsidian 위치       | Notion 표현        | 역방향                   |
| ------------------- | ------------------ | ------------------------ |
| YAML `tags: [a, b]` | multi_select 속성  | multi_select → YAML tags |
| 본문 인라인 `#tag`  | 텍스트 그대로 보존 | 그대로 유지              |

### B-6. 이미지

| 방향            | 변환                            | 세부                           |
| --------------- | ------------------------------- | ------------------------------ |
| Obsidian→Notion | `![](path)` → file upload API   | 로컬 이미지 업로드             |
| Notion→Obsidian | image block → `![](local_path)` | 즉시 다운로드 (1시간 URL 만료) |

SHA-256 해시 기반 중복 방지. `attachments/` 폴더에 저장.

### B-7. 위키링크 ↔ Notion Page Mention

| Obsidian 구문      | Notion 표현                          |
| ------------------ | ------------------------------------ |
| `[[Page Name]]`    | page mention (매핑 테이블로 ID 조회) |
| `[[Page\|별칭]]`   | page mention + plain_text 커스텀     |
| `[[Page#Heading]]` | 텍스트 링크 (heading mention 미지원) |

**핵심: WikilinkMapping 테이블**

```typescript
interface WikilinkMapping {
  obsidianPath: string; // "Projects/Project A.md"
  obsidianAliases: string[]; // ["Project A", "프로젝트A"]
  notionPageId: string; // "abc123-def456"
  notionUrl: string; // "https://notion.so/abc123def456"
}
```

전처리기에서 `[[...]]` → `[text](notion://page-id)` 변환 후 martian에 전달.
후처리기에서 page mention → `[[파일명]]` 역변환.

### B-8. Notion 인라인 색상 → Obsidian

**HTML span + CSS 클래스 방식:**

```markdown
<span class="notion-red">빨간 텍스트</span>
<span class="notion-blue_background">파란 배경</span>
```

**CSS snippet (`im-nobsidian-colors.css`) 제공:**

```css
.notion-gray {
  color: #787774;
}
.notion-brown {
  color: #9f6b53;
}
.notion-orange {
  color: #d9730d;
}
.notion-yellow {
  color: #cb912f;
}
.notion-green {
  color: #448361;
}
.notion-blue {
  color: #487ca5;
}
.notion-purple {
  color: #9065b0;
}
.notion-pink {
  color: #c14c8a;
}
.notion-red {
  color: #d44c47;
}
.notion-gray_background {
  background-color: #f1f1ef;
  padding: 0 2px;
  border-radius: 3px;
}
.notion-brown_background {
  background-color: #f4eeee;
}
.notion-orange_background {
  background-color: #fbecdd;
}
.notion-yellow_background {
  background-color: #fbf3db;
}
.notion-green_background {
  background-color: #edf3ec;
}
.notion-blue_background {
  background-color: #e7f3f8;
}
.notion-purple_background {
  background-color: #f4f0f7;
}
.notion-pink_background {
  background-color: #f9eef3;
}
.notion-red_background {
  background-color: #fdebec;
}
```

특수 케이스: `yellow_background` → Obsidian `==하이라이트==` 사용 가능 (설정 옵션)

역방향: `class="notion-*"` 패턴 파싱 → Notion `annotations.color` 복원

### B-9. Notion Column Layout → Obsidian

**Callout 기반 컬럼 (Columns 플러그인 호환):**

```markdown
%% im-nobsidian:column_list:start:columns=2:widths=1,1 %%

> [!col]
>
> > [!col-md]
> > 첫 번째 컬럼 내용
>
> > [!col-md]
> > 두 번째 컬럼 내용
> > %% im-nobsidian:column_list:end %%
```

- MCL CSS snippet 또는 Columns 플러그인으로 시각적 렌더링
- 플러그인 없이도 callout 블록으로 내용 표시됨
- preserve marker에 컬럼 수/너비 비율 보존 → Notion 복원 시 정확한 column_list 생성

### B-10. Notion Toggle Heading → Obsidian

```markdown
%% im-nobsidian:toggle_heading:level=2 %%

> [!toggle]- 토글 제목 (H2)
> 접힌 내용이 여기에 표시됩니다.
```

- Obsidian 네이티브 callout 접기 (`-` 접힘 / `+` 펼침)
- preserve marker에 heading level 보존 → Notion 복원 시 `is_toggleable: true` heading으로 생성

### B-11. Notion Page Cover & Icon → Obsidian

```yaml
---
banner: "attachments/covers/page-cover.jpg"
banner_icon: "🚀"
im_nobsidian_cover:
  type: external
  url: "https://images.unsplash.com/photo-xxx"
im_nobsidian_icon:
  type: emoji
  emoji: "🚀"
---
```

- `banner` / `banner_icon`: Banner 또는 Pixel Banner 플러그인이 자동 렌더링
- `im_nobsidian_cover` / `im_nobsidian_icon`: 원본 데이터 보존 (Notion 복원용)
- 커버 이미지는 `attachments/covers/` 에 다운로드

### B-12. Notion Embeds → Obsidian

```markdown
%% im-nobsidian:embed:type=video:source=youtube:url=https://youtu.be/xxx %%

<iframe width="560" height="315" src="https://www.youtube.com/embed/xxx" frameborder="0" allowfullscreen></iframe>
```

| Notion embed type | Obsidian 변환                          |
| ----------------- | -------------------------------------- |
| video (YouTube)   | `<iframe src="youtube.com/embed/...">` |
| embed (일반 URL)  | `<iframe src="URL">`                   |
| bookmark          | `[제목](URL)` + preserve marker        |
| pdf               | `![[file.pdf]]` (로컬) 또는 `<iframe>` |

- Reading View에서 iframe 렌더링
- preserve marker에 원본 embed 타입 보존 → 정확한 Notion 블록 복원

---

## DB등급: 데이터베이스 변환 (구조적 매핑)

### DB-1. Notion Database → Obsidian 폴더

```
Notion Database  =  Obsidian 폴더 (1 DB = 1 folder)
Notion Row/Page  =  마크다운 파일 (1 row = 1 .md file)
Notion Property  =  YAML 프론트매터 (1 column = 1 field)
Notion View      =  뷰 파일 (_views/ 하위)
```

**예시: Notion Task 데이터베이스의 한 Row:**

```yaml
# databases/Tasks/Task-001.md
---
notion_id: "abc123-def456"
notion_uid: "TASK-42"
title: "로그인 페이지 구현"
status: "In Progress"
status_group: "active"
priority: 3
assignees:
  - "홍길동"
tags:
  - frontend
  - react
due_date: 2026-06-15
estimated_hours: 8
related_project: "[[Project-Alpha]]"
created: 2026-05-01T09:30:00
updated: 2026-05-08T14:22:00
---
로그인 페이지 구현 내용...
```

### DB-2. Notion Property Type → Frontmatter 매핑

| Notion Property  | Frontmatter 타입                  | 비고                                   |
| ---------------- | --------------------------------- | -------------------------------------- |
| title            | 파일명                            | frontmatter에도 보관 가능              |
| rich_text        | string                            |                                        |
| number           | number                            |                                        |
| select           | string                            |                                        |
| multi_select     | string[]                          |                                        |
| date             | ISO date string                   | range는 `_start` / `_end` 분리         |
| checkbox         | boolean                           |                                        |
| url              | string                            |                                        |
| email            | string                            |                                        |
| phone_number     | string                            |                                        |
| relation         | `["[[link]]"]`                    | wikilink 배열                          |
| rollup           | Dataview 쿼리 + `_rollup_*` 캐시  | 아래 상세                              |
| formula          | Bases formula + `_formula_*` 캐시 | 아래 상세                              |
| files            | `["attachments/..."]`             | 로컬 다운로드                          |
| people           | string[]                          |                                        |
| created_time     | ISO date                          |                                        |
| last_edited_time | ISO date                          |                                        |
| created_by       | string                            |                                        |
| last_edited_by   | string                            |                                        |
| status           | string + `_group` 필드            | 그룹(not_started/active/complete) 보존 |
| unique_id        | string (e.g. "TASK-42")           | `notion_uid` 필드                      |

### DB-3. Notion Database Views → Obsidian 뷰 파일

각 뷰는 `databases/{DB이름}/_views/` 폴더에 별도 파일로 생성:

#### TABLE View → Dataview TABLE 또는 .base 파일

`````markdown
<!-- databases/Tasks/_views/table-all.md -->

# 전체 작업 목록

````dataview
TABLE
  status AS "상태",
  assignees AS "담당자",
  due_date AS "마감일",
  priority AS "우선순위"
FROM "databases/Tasks"
WHERE status != "완료"
SORT priority DESC, due_date ASC
```​
````
`````

`````

또는 Bases 네이티브:

```yaml
# databases/Tasks/_views/table-all.base
filter: file.folder = "databases/Tasks" AND status != "완료"
views:
  - type: table
    name: "전체 작업"
    order: [priority, due_date]
```

**Notion Filter → Dataview WHERE 매핑:**

| Notion Filter           | Dataview WHERE                     |
| ----------------------- | ---------------------------------- |
| Status is "In progress" | `WHERE status = "In progress"`     |
| Due date before today   | `WHERE due_date < date(today)`     |
| Tags contain "frontend" | `WHERE contains(tags, "frontend")` |
| Priority > 3            | `WHERE priority > 3`               |
| Assignee is not empty   | `WHERE assignees`                  |

#### BOARD View → Kanban 플러그인

```markdown
## <!-- databases/Tasks/_views/board-status.md -->

## kanban-plugin: board

## To Do

- [ ] [[Task-001]] @{2026-06-01} #high
- [ ] [[Task-002]] 디자인 검토

## In Progress

- [ ] [[Task-004]] 로그인 페이지 구현 @{2026-05-15}

## Done

- [x] [[Task-006]] 프로젝트 초기 셋업

%% kanban:settings
{"kanban-plugin":"board","list-collapse":[false,false,false]}
%%
```

#### CALENDAR View → Dataview CALENDAR

````markdown
<!-- databases/Tasks/_views/calendar.md -->

# 작업 캘린더

````dataview
CALENDAR due_date
FROM "databases/Tasks"
WHERE due_date AND status != "완료"
```​
`````

`````

#### GALLERY View → DataCards 또는 Bases Cards

````markdown
<!-- databases/Tasks/_views/gallery.md -->

````dataviewjs
const pages = dv.pages('"databases/Portfolio"')
  .where(p => p.cover_image)
  .sort(p => p.created, 'desc');

let html = '<div class="gallery-grid">';
for (const p of pages) {
  html += `<div class="gallery-card">
    <img src="${app.vault.adapter.basePath}/${p.cover_image}" />
    <div class="gallery-card-title">${p.file.link}</div>
    <div class="gallery-card-meta">${p.category || ''} | ${p.created || ''}</div>
  </div>`;
}
html += '</div>';
dv.el("div", html);
```​
`````

`````

CSS snippet (`im-nobsidian-gallery.css`) 동봉.

#### TIMELINE View → Mermaid Gantt

````markdown
<!-- databases/Tasks/_views/timeline.md -->

# 프로젝트 타임라인

````mermaid
gantt
    title 프로젝트 타임라인
    dateFormat YYYY-MM-DD
    section 기획
        요구사항 분석    :done, req, 2026-05-01, 2026-05-07
    section 개발
        백엔드 API       :active, dev-be, 2026-05-10, 2026-06-01
```​
`````

`````

전처리기가 Notion Timeline 데이터로부터 Mermaid gantt 코드를 자동 생성.

#### LIST View → Dataview LIST

````markdown
<!-- databases/Tasks/_views/list-active.md -->

````dataview
LIST WITHOUT ID
  file.link + " | " + status + " | 마감: " + due_date
FROM "databases/Tasks"
WHERE status != "완료"
SORT priority DESC
```​
`````

`````

### DB-4. Notion Relation → Obsidian Wikilink

```yaml
# Project-Alpha.md
---
related_tasks:
  - "[[Task-001]]"
  - "[[Task-004]]"
---
```

**양방향 조회:**

- 아웃링크: 프론트매터 `related_tasks` 직접 참조
- 백링크: Dataview `FROM [[Project-Alpha]]` 또는 Obsidian 네이티브 백링크 패널
- Self-relation: `blocks: "[[Task-C]]"`, `blocked_by: "[[Task-A]]"`

### DB-5. Notion Rollup → Dataview 집계 + 캐시

````markdown
## 작업 시간 합계

````dataview
TABLE
  sum(rows.estimated_hours) AS "총 시간",
  length(rows) AS "태스크 수",
  round(average(rows.estimated_hours), 1) AS "평균"
FROM "databases/Tasks"
WHERE contains(related_project, [[]])
GROUP BY true
```​
`````

````

**Notion Rollup → Dataview 함수 매핑:**

| Notion Rollup | Dataview                                                             |
| ------------- | -------------------------------------------------------------------- |
| Sum           | `sum(rows.field)`                                                    |
| Average       | `average(rows.field)`                                                |
| Min / Max     | `min(rows.field)` / `max(rows.field)`                                |
| Count all     | `length(rows)`                                                       |
| Count values  | `length(filter(rows, (r) => r.field != null))`                       |
| Count unique  | `length(unique(rows.field))`                                         |
| Percent empty | `(length(filter(rows, (r) => r.field = null)) / length(rows)) * 100` |
| Show original | `rows.field`                                                         |

프론트매터에 캐시값 보존 (Dataview 미설치 환경 대응):

```yaml
---
_rollup_total_hours: 42
_rollup_task_count: 7
_rollup_last_synced: 2026-05-08T10:00:00Z
---
```

### DB-6. Notion Formula → Bases Formula + 캐시

**Notion → Obsidian Bases 함수 매핑:**

| Notion                           | Obsidian Bases                      | 비고   |
| -------------------------------- | ----------------------------------- | ------ |
| `prop("Name")`                   | `Name` (직접 참조)                  |        |
| `if(cond, a, b)`                 | `if(cond, a, b)`                    | 동일   |
| `concat(a, b)`                   | `a + b`                             | 연산자 |
| `now()`                          | `now()`                             | 동일   |
| `dateAdd(date, n, unit)`         | `date + duration("Nd")`             |        |
| `dateBetween(d1, d2, unit)`      | `d1 - d2`                           |        |
| `formatDate(date, fmt)`          | `date.format("YYYY-MM-DD")`         |        |
| `length(str)`                    | `str.length`                        |        |
| `contains(str, sub)`             | `str.contains(sub)`                 |        |
| `round()` / `ceil()` / `floor()` | `.round()` / `.ceil()` / `.floor()` |        |
| `abs(num)`                       | `num.abs()`                         |        |

**변환 불가 함수 → 캐시 전략:**

```yaml
---
_formula_total_with_tax: 1100
_formula_source: 'lets(x, prop("Price"), y, prop("Qty"), x * y * 1.1)'
_formula_last_synced: 2026-05-08T10:00:00Z
---
```

`lets()`, `match()`, `replaceAll()` 등은 Bases에 직접 등가물 없음 → 결과값 캐싱 + 원본 수식 보존.

### DB-7. 데이터베이스 스키마 메타 파일

```yaml
# databases/Tasks/_schema.yml
database_id: "notion-db-uuid"
title: "Tasks"
properties:
  status:
    type: status
    groups:
      not_started: ["To Do", "Backlog"]
      active: ["In Progress", "Review"]
      complete: ["Done", "Archived"]
  priority:
    type: number
    format: number
  tags:
    type: multi_select
    options: ["frontend", "backend", "design"]
views:
  - id: "view-uuid-1"
    name: "전체 테이블"
    type: table
    file: "_views/table-all.base"
  - id: "view-uuid-2"
    name: "상태별 보드"
    type: board
    file: "_views/board-status.md"
last_synced: 2026-05-08T10:00:00Z
```

---

## C등급: 보존 전략 (원본 코드/데이터 완전 보존)

### C-1. Obsidian Dataview → Notion

**이중 표현: 코드 보존 + 정적 결과**

Notion에 두 블록으로 변환:

1. **코드 블록** (caption: `im-nobsidian:preserve:dataview`): 쿼리 원본 보존
2. **정적 테이블** (선택): 동기화 시점의 쿼리 결과를 Notion 테이블로 렌더링

```json
{
  "type": "code",
  "code": {
    "language": "plain text",
    "rich_text": [{ "text": { "content": "TABLE status, due_date FROM \"Projects\"..." } }],
    "caption": [{ "text": { "content": "im-nobsidian:preserve:dataview" } }]
  }
}
```

**라운드트립:** caption 마커 감지 → 원본 Dataview 코드 블록으로 복원. 정적 테이블은 무시.

### C-2. Obsidian Templater → Notion

- **실행 완료 템플릿**: 결과만 동기화 (일반 텍스트)
- **미실행 템플릿**: 전체 파일을 코드 블록으로 보존

```json
{
  "type": "code",
  "code": {
    "language": "javascript",
    "rich_text": [{ "text": { "content": "# <% tp.file.title %>..." } }],
    "caption": [{ "text": { "content": "im-nobsidian:preserve:templater" } }]
  }
}
```

감지 로직: `<% ... %>` 패턴 정규식 (`/<%[\s\S]*?%>/g`)

### C-3. Obsidian Block Reference → Notion

| 상황                          | Notion 표현                                  |
| ----------------------------- | -------------------------------------------- |
| `![[note^block-id]]` (임베드) | synced block 시도 → 실패 시 callout + 스냅샷 |
| `[[note^block-id]]` (링크)    | block 텍스트 링크                            |

Synced block API 제한: 원본 content 업데이트 불가, 양쪽 접근 권한 필요.

**fallback 변환:**

```json
{
  "type": "callout",
  "callout": {
    "icon": { "emoji": "📎" },
    "color": "blue_background",
    "rich_text": [
      { "text": { "content": "Embedded from: " } },
      { "mention": { "page": { "id": "..." } } }
    ]
  }
}
```

**라운드트립:** preserve marker에 원본 참조 `note^block-id` 보존 → `![[...]]`로 복원.

### C-4. Notion Synced Block → Obsidian

```markdown
%% im-nobsidian:synced-block:abc123:source %%
![[_synced_blocks/abc123]]
```

- source page에 원본 블록 저장 (`_synced_blocks/abc123.md`)
- 참조 페이지에서 transclusion `![[...]]`으로 표시
- **제한:** Obsidian transclusion은 읽기 전용 (소스에서만 편집)
- **향상:** Mirror 플러그인으로 양방향 편집 가능

### C-5. Obsidian Comments → Notion

```markdown
이것은 공개 텍스트입니다.
%%이것은 숨겨진 메모입니다%%
```

Notion 변환: 접힌 toggle 블록 (caption: `im-nobsidian:preserve:comment`)

설정 옵션:

- `toggle`: 접힌 toggle 블록 (기본값)
- `skip`: Notion에 전송하지 않음
- `gray-text`: 회색 텍스트로 표시

### C-6. Obsidian Canvas → Notion

`.canvas` 파일 (JSON Canvas 포맷) 처리:

설정 옵션:

- `skip`: 동기화 제외 (기본값)
- `preserve-json`: JSON 코드 블록으로 보존
- `convert-mermaid`: Mermaid 다이어그램으로 자동 변환
- `both`: Mermaid 시각화 + JSON 보존 (권장)

`both` 모드: callout 안내 + mermaid 렌더링 + toggle 내 JSON 원본

```typescript
function canvasToMermaid(canvas: JsonCanvas): string {
  const lines = ["flowchart LR"];
  for (const node of canvas.nodes) {
    const label = node.type === "text" ? node.text : node.type === "file" ? node.file : node.url;
    lines.push(`  ${node.id}["${escapeLabel(label)}"]`);
  }
  for (const edge of canvas.edges) {
    const arrow = edge.toEnd === "arrow" ? "-->" : "---";
    lines.push(`  ${edge.fromNode} ${arrow} ${edge.toNode}`);
  }
  return lines.join("\n");
}
```

### C-7. Notion 댓글 (Discussion)

Notion 페이지/블록 댓글은 토론 스레드 → 동기화 제외 (기본). Obsidian 댓글 `%%...%%`과는 다른 개념.

---

## Preserve Marker 시스템 (ADR-003)

모든 변환 불가/부분 변환 기능은 preserve marker로 라운드트립 보장:

### Obsidian 측 (Obsidian 주석)

```markdown
%% im-nobsidian:{type}:{metadata} %%
```

예시:

```
%% im-nobsidian:column_list:start:columns=2:widths=1,1 %%
%% im-nobsidian:toggle_heading:level=2 %%
%% im-nobsidian:synced-block:abc123:source %%
%% im-nobsidian:embed:type=video:source=youtube:url=https://youtu.be/xxx %%
%% im-nobsidian:table_of_contents %%
```

### Notion 측 (코드 블록 caption)

```
caption: "im-nobsidian:preserve:{type}:{metadata}"
```

예시:

```
im-nobsidian:preserve:dataview
im-nobsidian:preserve:templater
im-nobsidian:preserve:comment
im-nobsidian:preserve:canvas:project-plan
im-nobsidian:preserve:block-ref:note^block-id
im-nobsidian:callout-type:warning:foldable:collapsed
```

---

## 변환 등급 요약 (기존 대비 변경)

| 기능           | 기존 등급        | 최종 등급 | 핵심 전략                            |
| -------------- | ---------------- | --------- | ------------------------------------ |
| Mermaid        | B                | **A**     | Notion 네이티브 mermaid 지원         |
| 수식 (LaTeX)   | B                | **A**     | 인라인/블록 직접 매핑                |
| 콜아웃         | B                | **B+**    | 타입→아이콘 매핑, foldable 메타 보존 |
| 위키링크       | C                | **B**     | page mention + 매핑 테이블           |
| 인라인 색상    | C (손실)         | **B**     | span+CSS 클래스, 역매핑 가능         |
| Column Layout  | C (순차 텍스트)  | **B**     | callout 컬럼 + CSS/플러그인          |
| Toggle Heading | C (details HTML) | **B**     | callout 접기 네이티브 지원           |
| 커버/아이콘    | 미등록           | **B**     | frontmatter + Banner 플러그인        |
| 임베드         | 미등록           | **B**     | iframe + preserve marker             |
| Database       | C (읽기 전용)    | **DB**    | 폴더+frontmatter+뷰 파일             |
| Relation       | C (캐싱)         | **DB**    | wikilink 배열 + Dataview             |
| Rollup         | C (캐싱)         | **DB**    | Dataview 집계 + 캐시                 |
| Formula        | 미등록           | **DB**    | Bases formula + 캐시                 |
| Dataview       | C                | **C**     | 코드 보존 + 정적 테이블              |
| Templater      | C                | **C**     | 코드 보존                            |
| Block Ref      | C                | **C**     | synced block 시도 + fallback         |
| Synced Block   | C                | **C**     | transclusion (읽기 전용)             |
| Canvas         | 미등록           | **C**     | Mermaid 변환 + JSON 보존             |
| Comments       | 미등록           | **C**     | toggle 블록 보존                     |

### 등급 정의 (수정)

- **A등급**: 완벽 변환, 손실 0%
- **B등급**: 대안 포맷 변환, 기능 보존 (형식만 다름), 라운드트립 가능
- **DB등급**: 데이터베이스 구조적 매핑, 폴더+frontmatter+뷰 시스템
- **C등급**: 원본 코드/데이터 100% 보존, 시각적 표현은 제한적

**"불가능" 등급은 존재하지 않음.** 모든 기능이 A~C 중 하나로 처리됨.

---

## 권장 플러그인 목록 (Progressive Enhancement)

Im-Nobsidian CSS snippet과 함께, 아래 플러그인 설치 시 시각적 경험 향상:

| 플러그인              | 향상되는 기능            | 필수 여부 |
| --------------------- | ------------------------ | --------- |
| Dataview              | DB 뷰, Rollup, 동적 쿼리 | 강력 권장 |
| Kanban                | Board 뷰                 | 선택      |
| Columns               | Column Layout 시각화     | 선택      |
| Banner / Pixel Banner | 페이지 커버/아이콘       | 선택      |
| Frontmatter Links     | 프론트매터 wikilink 클릭 | 선택      |

---

## 구현 우선순위

1. **전처리/후처리 파이프라인 아키텍처** -- 모든 변환의 기반
2. **위키링크 매핑 테이블** -- 가장 핵심적인 인프라
3. **프론트매터 ↔ Properties 매핑** -- 데이터 모델의 기반
4. **콜아웃 매핑** -- 사용 빈도 높고 매핑 명확
5. **인라인 색상 / 컬럼 레이아웃** -- B등급 승격 항목
6. **데이터베이스 구조 매핑** -- 폴더+frontmatter+뷰
7. **preserve marker 시스템** -- C등급 항목 공통 인프라
````
