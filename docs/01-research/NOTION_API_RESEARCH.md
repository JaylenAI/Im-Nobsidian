# Notion API 리서치

> 작성일: 2026-05-08
> 최종 수정: 2026-05-08
> 상태: active
> API 기준 버전: `2026-03-11` (최신)

---

## 목차

1. [인증 (Authentication)](#1-인증-authentication)
2. [핵심 동기화 엔드포인트](#2-핵심-동기화-엔드포인트)
3. [Rate Limits](#3-rate-limits-critical)
4. [페이지네이션](#4-페이지네이션)
5. [블록 타입 전체 목록](#5-블록-타입-전체-목록)
6. [Rich Text 객체](#6-rich-text-객체)
7. [데이터베이스 속성 타입 전체 목록](#7-데이터베이스-속성-타입-전체-목록)
8. [2025-2026 API 업데이트](#8-2025-2026-api-업데이트)
9. [알려진 제한사항](#9-알려진-제한사항)
10. [웹훅 상세](#10-웹훅-상세)
11. [동기화 도구 베스트 프랙티스](#11-동기화-도구-베스트-프랙티스)

---

## 1. 인증 (Authentication)

### 1.1 Internal Integration vs Public Integration (OAuth 2.0)

| 항목          | Internal Integration       | Public Integration (OAuth 2.0)             |
| ------------- | -------------------------- | ------------------------------------------ |
| 대상          | 단일 워크스페이스 전용     | 다중 워크스페이스 (SaaS 배포)              |
| 토큰 유형     | 정적 토큰 (`ntn_` 접두사)  | OAuth access_token + refresh_token         |
| 토큰 생성     | Creator Dashboard에서 발급 | OAuth 플로우 완료 시 자동 발급             |
| 토큰 만료     | 만료 없음 (수동 재발급)    | access_token 만료 → refresh_token으로 갱신 |
| 사용 시나리오 | 개인/팀 내부 도구          | 제3자 앱, 마켓플레이스                     |

**Im-Nobsidian 전략**: Internal Integration 기본 → v2+에서 OAuth 지원

### 1.2 Capabilities (권한/스코프)

Notion은 전통적인 OAuth scope 대신 **Capabilities** 모델을 사용한다. Integration 생성 시 설정하며, OAuth 플로우마다 변경되지 않는다.

#### Content Capabilities

| Capability         | 설명             | 필요 엔드포인트                            |
| ------------------ | ---------------- | ------------------------------------------ |
| **Read content**   | 기존 콘텐츠 읽기 | Retrieve page/block/database, Search       |
| **Update content** | 기존 콘텐츠 수정 | Update page, Update block, Update database |
| **Insert content** | 새 콘텐츠 생성   | Create page, Append block children         |

#### Comment Capabilities

| Capability          | 설명                  |
| ------------------- | --------------------- |
| **Read comments**   | 페이지/블록 댓글 읽기 |
| **Insert comments** | 댓글 작성             |

#### User Information Capabilities

| 레벨                | 포함 정보                   |
| ------------------- | --------------------------- |
| No user information | 사용자 정보 없음            |
| Without email       | 이름, 프로필 이미지         |
| With email          | 이름, 프로필 이미지, 이메일 |

> **핵심 제약**: Connection의 capability는 절대로 해당 사용자의 권한을 초과할 수 없다.

**Im-Nobsidian에 필요한 Capabilities**: Read content, Update content, Insert content, Read comments (선택)

### 1.3 Internal Integration 토큰 발급 (단계별)

1. https://www.notion.so/my-integrations 접속
2. **"+ 새 통합"** 클릭
3. 통합 이름, 로고, 연결 워크스페이스 설정
4. Capabilities 선택 (Read/Update/Insert content)
5. **"제출"** → `ntn_xxxxxxxxxxxx` 형태의 토큰 발급
6. Notion에서 동기화 대상 페이지 열기 → **"…" → "연결 추가"** → 생성한 통합 선택
7. 하위 페이지에 자동 상속 (또는 개별 설정)

### 1.4 OAuth 2.0 플로우

#### Step 1: Authorization 요청

```
GET https://api.notion.com/v1/oauth/authorize
  ?client_id={CLIENT_ID}
  &redirect_uri={REDIRECT_URI}
  &response_type=code
  &owner=user
  &state={CSRF_TOKEN}
```

사용자가 페이지 선택 → 승인 → redirect_uri로 `code` 전달

#### Step 2: Token Exchange

```http
POST https://api.notion.com/v1/oauth/token
Authorization: Basic base64({CLIENT_ID}:{CLIENT_SECRET})
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "code": "{AUTHORIZATION_CODE}",
  "redirect_uri": "{REDIRECT_URI}"
}
```

**응답:**

```json
{
  "access_token": "ntn_...",
  "refresh_token": "nrt_...",
  "bot_id": "uuid",
  "duplicated_template_id": null,
  "owner": { "type": "user", "user": { ... } },
  "workspace_icon": "url",
  "workspace_id": "uuid",
  "workspace_name": "My Workspace"
}
```

#### Step 3: Token Refresh

```http
POST https://api.notion.com/v1/oauth/token
Authorization: Basic base64({CLIENT_ID}:{CLIENT_SECRET})
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "refresh_token": "nrt_..."
}
```

응답: 새 `access_token` + 새 `refresh_token` 반환

> **주의**: refresh_token도 만료되거나 무효화될 수 있으며, 이 경우 `invalid_grant` 에러 → 사용자 재인증 필요

### 1.5 API 요청 헤더

```http
Authorization: Bearer {ACCESS_TOKEN}
Notion-Version: 2026-03-11
Content-Type: application/json
```

---

## 2. 핵심 동기화 엔드포인트

### 2.1 Pages (페이지)

| 작업          | Method | Path                           | 설명                                                  |
| ------------- | ------ | ------------------------------ | ----------------------------------------------------- |
| 생성          | POST   | `/v1/pages`                    | 페이지 생성 (parent + properties + children/markdown) |
| 조회          | GET    | `/v1/pages/{page_id}`          | 페이지 속성 조회 (콘텐츠 미포함)                      |
| 수정          | PATCH  | `/v1/pages/{page_id}`          | 속성/아이콘/커버 수정                                 |
| 아카이브      | PATCH  | `/v1/pages/{page_id}`          | `{ "archived": true }`                                |
| 마크다운 조회 | GET    | `/v1/pages/{page_id}/markdown` | 전체 페이지 마크다운 반환                             |
| 마크다운 수정 | PATCH  | `/v1/pages/{page_id}/markdown` | 마크다운으로 콘텐츠 업데이트                          |
| 벌크 수정     | PATCH  | `/v1/pages/bulk`               | 최대 100개 페이지 일괄 업데이트                       |

#### Create Page 요청 예시

```json
{
  "parent": { "page_id": "parent-page-uuid" },
  "properties": {
    "title": [{ "text": { "content": "페이지 제목" } }]
  },
  "children": [
    {
      "object": "block",
      "type": "paragraph",
      "paragraph": {
        "rich_text": [{ "text": { "content": "본문 내용" } }]
      }
    }
  ]
}
```

또는 `markdown` 파라미터로 생성 가능 (`children`과 상호 배타적):

```json
{
  "parent": { "page_id": "parent-page-uuid" },
  "markdown": "# 제목\n\n본문 내용"
}
```

#### Markdown Update 명령

| 명령              | 설명                                        |
| ----------------- | ------------------------------------------- |
| `update_content`  | `old_str` / `new_str` 쌍으로 특정 부분 치환 |
| `replace_content` | 전체 페이지 마크다운 교체                   |

### 2.2 Blocks (블록)

| 작업           | Method | Path                             | 설명                                    |
| -------------- | ------ | -------------------------------- | --------------------------------------- |
| 자식 블록 조회 | GET    | `/v1/blocks/{block_id}/children` | 자식 블록 목록 (페이지네이션)           |
| 자식 블록 추가 | PATCH  | `/v1/blocks/{block_id}/children` | 블록 추가 (최대 100개/요청, 2단계 중첩) |
| 블록 조회      | GET    | `/v1/blocks/{block_id}`          | 단일 블록 조회                          |
| 블록 수정      | PATCH  | `/v1/blocks/{block_id}`          | 블록 내용/속성 수정                     |
| 블록 삭제      | DELETE | `/v1/blocks/{block_id}`          | 블록 삭제 (아카이브)                    |

> **핵심**: 한 요청에 **최대 2단계 중첩**만 가능. 더 깊은 중첩은 부모 블록 ID를 참조해 재귀적으로 생성해야 함.

#### Append Block Children 요청 예시

```json
{
  "children": [
    {
      "object": "block",
      "type": "heading_2",
      "heading_2": {
        "rich_text": [{ "text": { "content": "섹션 제목" } }]
      }
    },
    {
      "object": "block",
      "type": "paragraph",
      "paragraph": {
        "rich_text": [{ "text": { "content": "본문" } }]
      }
    }
  ]
}
```

### 2.3 Databases / Data Sources

> **2025-09-03 주요 변경**: `database` → `data_source` 패러다임 전환. 하나의 database에 여러 data source가 연결 가능.

| 작업    | Method | Path                                      | 비고                            |
| ------- | ------ | ----------------------------------------- | ------------------------------- |
| DB 조회 | GET    | `/v1/databases/{database_id}`             | data_source 목록 반환           |
| DS 조회 | GET    | `/v1/data_sources/{data_source_id}`       | 스키마(속성) 조회               |
| DS 쿼리 | POST   | `/v1/data_sources/{data_source_id}/query` | 필터/정렬/페이지네이션          |
| DS 생성 | POST   | `/v1/data_sources`                        | DB에 새 data source 추가        |
| DB 수정 | PATCH  | `/v1/databases/{database_id}`             | title, icon, cover, parent 수정 |

#### Database Query 요청 예시

```json
{
  "filter": {
    "and": [
      {
        "property": "Status",
        "status": { "equals": "Done" }
      },
      {
        "property": "Date",
        "date": { "after": "2026-01-01" }
      }
    ]
  },
  "sorts": [{ "property": "Date", "direction": "descending" }],
  "page_size": 100
}
```

### 2.4 Search

| 작업 | Method | Path         | 설명                   |
| ---- | ------ | ------------ | ---------------------- |
| 검색 | POST   | `/v1/search` | 워크스페이스 전체 검색 |

**요청:**

```json
{
  "query": "검색어",
  "filter": { "value": "page", "property": "object" },
  "sort": { "direction": "descending", "timestamp": "last_edited_time" },
  "page_size": 100,
  "start_cursor": "..."
}
```

**필터 값**: `"page"` 또는 `"data_source"` (2025-09-03부터 `"database"` 대신 `"data_source"` 사용)

> **경고**: Search는 **전체 열거에 최적화되어 있지 않다**. 인덱싱 지연이 있으며, 특정 DB 내 검색은 Query endpoint를 사용해야 한다.

### 2.5 Users

| 작업             | Method | Path                  | 설명                                |
| ---------------- | ------ | --------------------- | ----------------------------------- |
| 전체 사용자 목록 | GET    | `/v1/users`           | 페이지네이션 지원 (최대 100/페이지) |
| 단일 사용자 조회 | GET    | `/v1/users/{user_id}` | ID로 조회                           |
| 현재 봇 조회     | GET    | `/v1/users/me`        | 토큰의 봇 사용자 정보               |

> `user information` capability 필요 (미설정 시 403)

### 2.6 Files (파일 업로드)

| 작업             | Method | Path                                | 설명                                   |
| ---------------- | ------ | ----------------------------------- | -------------------------------------- |
| 업로드 객체 생성 | POST   | `/v1/file_uploads`                  | File Upload 객체 생성, upload_url 반환 |
| 파일 전송        | POST   | `{upload_url}`                      | multipart/form-data로 파일 전송        |
| 업로드 조회      | GET    | `/v1/file_uploads/{file_upload_id}` | 업로드 상태 확인                       |

**파일 크기 제한:**

- Free 플랜: 5 MiB/파일
- 유료 플랜: 5 GiB/파일
- 20 MiB 초과 시 멀티파트 업로드 필수 (파트당 5~20 MiB)
- 업로드 후 **1시간 이내**에 블록에 첨부해야 함 (미첨부 시 만료)

### 2.7 Comments

| 작업      | Method | Path                         | 설명                  |
| --------- | ------ | ---------------------------- | --------------------- |
| 댓글 목록 | GET    | `/v1/comments?block_id={id}` | 블록/페이지 댓글 조회 |
| 댓글 생성 | POST   | `/v1/comments`               | 페이지에 댓글 추가    |
| 댓글 수정 | PATCH  | `/v1/comments/{comment_id}`  | 댓글 수정             |
| 댓글 삭제 | DELETE | `/v1/comments/{comment_id}`  | 댓글 삭제             |

- `read comments` capability 필요 (기본 비활성화)
- 댓글 생성 시 `rich_text` 또는 `markdown` 본문 택1 (둘 다 필수는 아님, 하나만)
- markdown 본문은 인라인 서식만 지원 (헤딩, 리스트 등 블록 구조 불가)

### 2.8 Views (뷰) — 2026-03-11 신규

| 작업           | Method | Path                        | 설명                |
| -------------- | ------ | --------------------------- | ------------------- |
| 뷰 목록        | GET    | `/v1/databases/{id}/views`  | DB의 뷰 목록        |
| 뷰 생성        | POST   | `/v1/databases/{id}/views`  | 새 뷰 생성          |
| 뷰 조회        | GET    | `/v1/views/{id}`            | 단일 뷰 조회        |
| 뷰 수정        | PATCH  | `/v1/views/{id}`            | 뷰 설정 변경        |
| 뷰 삭제        | DELETE | `/v1/views/{id}`            | 뷰 삭제             |
| 뷰 복제        | POST   | `/v1/views/{id}/duplicate`  | 뷰 복제             |
| 뷰 속성 설정   | PATCH  | `/v1/views/{id}/properties` | 표시 컬럼 설정      |
| 뷰를 통한 쿼리 | POST   | `/v1/views/{id}/query`      | 뷰 기준 데이터 조회 |

**지원 뷰 타입**: table, board, calendar, timeline, gallery, list, form, chart, map, dashboard

---

## 3. Rate Limits (CRITICAL)

### 3.1 기본 제한

| 항목              | 값                                                     |
| ----------------- | ------------------------------------------------------ |
| 지속 속도         | **3 req/s** (connection 당)                            |
| 버스트            | 유휴 시 버킷 최대 **10**까지 충전, 10개 연속 요청 가능 |
| 15분 환산         | 약 2,700 요청/15분/토큰                                |
| Search 엔드포인트 | 내부적으로 ~1 req/s 더 엄격한 제한                     |
| 플랜별 차이       | 속도 제한은 **모든 플랜 동일** (3 req/s)               |
| Free 플랜 월간    | **10,000 API 요청/월**                                 |
| 유료 플랜 월간    | 월간 제한 없음                                         |

### 3.2 Rate Limit 응답 처리

```
HTTP/1.1 429 Too Many Requests
Retry-After: 1

{
  "object": "error",
  "status": 429,
  "code": "rate_limited",
  "message": "Rate limited"
}
```

- `Retry-After` 헤더: 초 단위 정수 (대기 시간)
- 헤더가 없을 경우 지수 백오프 (1s → 2s → 4s → 8s → 16s)
- 랜덤 지터 추가로 thundering herd 방지

### 3.3 크기 제한

| 항목                 | 제한             |
| -------------------- | ---------------- |
| 요청 페이로드        | **500 KB**       |
| 요청 당 블록 수      | **1,000개**      |
| 블록 배열 길이       | 100개            |
| Rich text 문자       | **2,000자/객체** |
| URL 길이             | 2,000자          |
| 수식(equation)       | 1,000자          |
| Multi-select 옵션    | 100개            |
| Relation 관련 페이지 | 100개            |
| People mention       | 100명            |
| 이메일 주소          | 200자            |
| 전화번호             | 200자            |

### 3.4 Rate Limit 준수 전략 (Im-Nobsidian)

```typescript
// async-sema로 3 req/s 제한
import { RateLimiter } from "async-sema";

const limiter = RateLimiter(3); // 초당 3개

async function notionRequest(fn: () => Promise<unknown>) {
  await limiter();
  try {
    return await fn();
  } catch (error) {
    if (error.status === 429) {
      const retryAfter = error.headers?.["retry-after"] ?? 1;
      await sleep(retryAfter * 1000 + Math.random() * 500);
      return notionRequest(fn); // 재시도
    }
    throw error;
  }
}
```

---

## 4. 페이지네이션

### 4.1 기본 패턴

모든 리스트 엔드포인트는 `start_cursor` / `has_more` 패턴 사용:

```typescript
// 전체 결과 수집
async function fetchAll<T>(
  queryFn: (cursor?: string) => Promise<PaginatedResponse<T>>,
): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | undefined;

  do {
    const response = await queryFn(cursor);
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}
```

### 4.2 파라미터

| 파라미터       | 위치                          | 설명                                     |
| -------------- | ----------------------------- | ---------------------------------------- |
| `page_size`    | GET: query string, POST: body | 페이지당 결과 수 (기본 10, **최대 100**) |
| `start_cursor` | GET: query string, POST: body | 이전 응답의 `next_cursor` 값             |

### 4.3 응답 구조

```json
{
  "object": "list",
  "results": [ ... ],
  "has_more": true,
  "next_cursor": "a1b2c3d4-...",
  "type": "page",
  "page_or_database": {}
}
```

### 4.4 대규모 워크스페이스 순회 전략

1. **page_size=100** 설정으로 요청 횟수 최소화
2. Search 대신 **Database Query**를 사용해 특정 DB 내 페이지 열거
3. `last_edited_time` 필터로 변경분만 조회 (delta sync)
4. 커서가 장시간 유지되지 않을 수 있음 → 안정적인 재시작 전략 필요
5. Search 인덱스는 순회 중 변경 가능 → 전체 열거에 부적합

---

## 5. 블록 타입 전체 목록

### 5.1 지원 블록 타입 (31종, 2026-03-11 기준)

| #   | type 값              | 설명                                           |       children 지원        |
| --- | -------------------- | ---------------------------------------------- | :------------------------: |
| 1   | `paragraph`          | 본문 텍스트                                    |             ✅             |
| 2   | `heading_1`          | H1 제목                                        | ✅ (is_toggleable=true 시) |
| 3   | `heading_2`          | H2 제목                                        | ✅ (is_toggleable=true 시) |
| 4   | `heading_3`          | H3 제목                                        | ✅ (is_toggleable=true 시) |
| 5   | `heading_4`          | H4 제목 (**2026 신규**)                        | ✅ (is_toggleable=true 시) |
| 6   | `bulleted_list_item` | 글머리 기호 목록                               |             ✅             |
| 7   | `numbered_list_item` | 번호 목록                                      |             ✅             |
| 8   | `to_do`              | 체크박스 항목                                  |             ✅             |
| 9   | `toggle`             | 토글 (접기/펼치기)                             |             ✅             |
| 10  | `quote`              | 인용문                                         |             ✅             |
| 11  | `callout`            | 콜아웃 (아이콘 + 배경)                         |             ✅             |
| 12  | `code`               | 코드 블록 (언어 지정)                          |             ❌             |
| 13  | `equation`           | 수식 (KaTeX)                                   |             ❌             |
| 14  | `divider`            | 구분선                                         |             ❌             |
| 15  | `table_of_contents`  | 목차 (자동 생성)                               |             ❌             |
| 16  | `breadcrumb`         | 브레드크럼                                     |             ❌             |
| 17  | `image`              | 이미지                                         |             ❌             |
| 18  | `video`              | 비디오                                         |             ❌             |
| 19  | `audio`              | 오디오                                         |             ❌             |
| 20  | `file`               | 파일 첨부                                      |             ❌             |
| 21  | `pdf`                | PDF 임베드                                     |             ❌             |
| 22  | `bookmark`           | 북마크 (URL + 캡션)                            |             ❌             |
| 23  | `embed`              | 외부 콘텐츠 임베드                             |             ❌             |
| 24  | `link_preview`       | URL 미리보기 (**읽기 전용**)                   |             ❌             |
| 25  | `child_page`         | 하위 페이지                                    |             ✅             |
| 26  | `child_database`     | 하위 데이터베이스                              |             ✅             |
| 27  | `column_list`        | 다중 컬럼 레이아웃 (부모)                      |             ✅             |
| 28  | `column`             | 개별 컬럼 (column_list의 자식)                 |             ✅             |
| 29  | `synced_block`       | 동기화 블록                                    |             ✅             |
| 30  | `table`              | 테이블                                         |      ✅ (table_row만)      |
| 31  | `table_row`          | 테이블 행                                      |             ❌             |
| 32  | `tab`                | 탭 컨테이너 (**2026 신규**)                    |             ✅             |
| 33  | `meeting_notes`      | 회의 노트 (**2026 rename**, 구 transcription)  |             ✅             |
| 34  | `template`           | 템플릿 (**deprecated**, 생성 불가)             |             ✅             |
| 35  | `unsupported`        | 미지원 타입 (block_type 필드로 원래 타입 식별) |             ❌             |

### 5.2 비지원 블록 타입

API에서 `unsupported` 타입으로 반환되는 것들:

- `form` (폼)
- `button` (버튼)
- 기타 UI 전용 요소

### 5.3 Im-Nobsidian 매핑 우선순위

**1순위 (필수)**: paragraph, heading_1~4, bulleted/numbered_list_item, to_do, toggle, quote, callout, code, equation, divider, image, table, table_row

**2순위 (중요)**: bookmark, embed, file, pdf, video, audio, child_page, synced_block, column_list/column

**3순위 (보류)**: link_preview, breadcrumb, table_of_contents, tab, meeting_notes

---

## 6. Rich Text 객체

### 6.1 구조

```json
{
  "type": "text",
  "text": {
    "content": "텍스트 내용",
    "link": { "url": "https://example.com" }
  },
  "annotations": {
    "bold": false,
    "italic": false,
    "strikethrough": false,
    "underline": false,
    "code": false,
    "color": "default"
  },
  "plain_text": "텍스트 내용",
  "href": "https://example.com"
}
```

### 6.2 Rich Text 타입

| type       | 설명                                                           | 주요 필드                                                           |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `text`     | 일반 텍스트                                                    | `content`, `link` (optional)                                        |
| `mention`  | 참조 (DB, 날짜, 페이지, 사용자, 링크 미리보기, 템플릿 mention) | `type` (database, date, link_preview, page, template_mention, user) |
| `equation` | 인라인 수식                                                    | `expression` (KaTeX 문법)                                           |

### 6.3 Annotations (서식)

| 속성            | 타입        | 설명             |
| --------------- | ----------- | ---------------- |
| `bold`          | boolean     | 굵은 글씨        |
| `italic`        | boolean     | 기울임           |
| `strikethrough` | boolean     | 취소선           |
| `underline`     | boolean     | 밑줄             |
| `code`          | boolean     | 인라인 코드      |
| `color`         | string enum | 텍스트/배경 색상 |

### 6.4 Color 전체 목록

**텍스트 색상 (10종)**:
`default`, `blue`, `brown`, `gray`, `green`, `orange`, `pink`, `purple`, `red`, `yellow`

**배경 색상 (10종)**:
`blue_background`, `brown_background`, `gray_background`, `green_background`, `orange_background`, `pink_background`, `purple_background`, `red_background`, `yellow_background`, `default` (배경 없음)

### 6.5 문자 제한

| 항목                       | 제한                     |
| -------------------------- | ------------------------ |
| Rich text 객체 1개         | **2,000자**              |
| 블록 당 rich text 배열     | **100개** 객체           |
| 따라서 블록 당 최대 텍스트 | ~200,000자 (2,000 × 100) |

---

## 7. 데이터베이스 속성 타입 전체 목록

### 7.1 사용자 정의 속성 (생성/수정 가능)

| type           | 설명                                     | API 읽기 | API 쓰기 |
| -------------- | ---------------------------------------- | :------: | :------: |
| `title`        | 페이지 제목 (DB당 1개 필수)              |    ✅    |    ✅    |
| `rich_text`    | 서식 있는 텍스트                         |    ✅    |    ✅    |
| `number`       | 숫자 (format: dollar, percent 등)        |    ✅    |    ✅    |
| `select`       | 단일 선택                                |    ✅    |    ✅    |
| `multi_select` | 다중 선택                                |    ✅    |    ✅    |
| `date`         | 날짜 (start, end, time_zone)             |    ✅    |    ✅    |
| `checkbox`     | 체크박스 (boolean)                       |    ✅    |    ✅    |
| `people`       | 사용자 참조                              |    ✅    |    ✅    |
| `files`        | 파일/미디어                              |    ✅    |    ✅    |
| `url`          | URL                                      |    ✅    |    ✅    |
| `email`        | 이메일                                   |    ✅    |    ✅    |
| `phone_number` | 전화번호                                 |    ✅    |    ✅    |
| `status`       | 상태 (그룹 지원, **2026부터 쓰기 가능**) |    ✅    |    ✅    |
| `relation`     | 다른 data source 참조                    |    ✅    |    ✅    |

### 7.2 계산/파생 속성

| type      | 설명                                          | API 읽기 | API 쓰기 |
| --------- | --------------------------------------------- | :------: | :------: |
| `formula` | 수식 기반 계산 (**2026-02-01부터 쓰기 가능**) |    ✅    |    ✅    |
| `rollup`  | 관계에서 집계된 값                            |    ✅    |    ❌    |

### 7.3 시스템 자동 생성 속성 (읽기 전용)

| type               | 설명                                      |
| ------------------ | ----------------------------------------- |
| `created_time`     | 생성 시각                                 |
| `created_by`       | 생성자                                    |
| `last_edited_time` | 마지막 수정 시각                          |
| `last_edited_by`   | 마지막 수정자                             |
| `unique_id`        | 자동 증가 ID (접두사 설정 가능, DB당 1개) |

### 7.4 특수 속성

| type           | 설명                                              | API 읽기 | API 쓰기 |
| -------------- | ------------------------------------------------- | :------: | :------: |
| `verification` | Wiki DB의 검증 상태 (verified/unverified/expired) |    ✅    |    ✅    |
| `place`        | Map 뷰용 위치 정보 (**2026 신규**)                |    ✅    |    ❌    |

---

## 8. 2025-2026 API 업데이트

### 8.1 버전 타임라인

| 버전           | 날짜       | 주요 변경사항                                                               |
| -------------- | ---------- | --------------------------------------------------------------------------- |
| **2025-09-03** | 2025-09    | Multi-source databases, data_sources 패러다임, 웹훅 통합                    |
| **2026-02-01** | 2026-02-03 | 벌크 연산 (PATCH /v1/pages/bulk, 100페이지/요청), 수식 속성 쓰기            |
| **2026-03-01** | 2026-03    | 웹훅 정식 출시, 댓글 수정/삭제 엔드포인트                                   |
| **2026-03-11** | 2026-03-11 | transcription → meeting_notes 이름 변경                                     |
| **2026-04-01** | 2026-04    | Views API (8개 엔드포인트), H4 블록, 탭 블록, 동기화 블록 복사, Status 쓰기 |

### 8.2 Multi-Source Databases (2025-09-03) — Breaking Change

**핵심 변경**: 하나의 database에 여러 data_source가 연결 가능해짐

- `GET /v1/databases/{id}` → data_source 목록 반환 (기존: 스키마 직접 반환)
- 새 엔드포인트: `GET /v1/data_sources/{id}` (스키마 조회)
- 쿼리: `/v1/databases/{id}/query` → `/v1/data_sources/{id}/query`
- 페이지 생성 시 parent: `database_id` → `data_source_id`
- Relation 속성: `database_id` → `data_source_id`
- Search 필터: `"database"` → `"data_source"`

**마이그레이션 6단계**:

1. data_source_id 디스커버리 및 캐싱 구현
2. 페이지 생성/Relation에 data_source_id 사용
3. DB 엔드포인트 → DS 엔드포인트 전환
4. Search 결과 처리 업데이트
5. TypeScript SDK v5.0.0+ 업그레이드
6. 웹훅 핸들러 업데이트

### 8.3 벌크 연산 (2026-02-01)

```http
PATCH https://api.notion.com/v1/pages/bulk
Notion-Version: 2026-02-01
```

- 최대 100개 페이지 일괄 업데이트
- 5,000페이지 업데이트: 개별 ~28분 → 벌크 ~17초
- 요청 수 최대 100배 절감

### 8.4 웹훅 (2026-03-01)

Notion의 공개 기능 트래커에서 3년간 1위 요청 기능이었음.
상세는 [10. 웹훅 상세](#10-웹훅-상세) 참조.

### 8.5 Views API (2026-04-01)

8개 엔드포인트로 뷰 CRUD + 쿼리 지원.
상세는 [2.8 Views](#28-views-뷰--2026-03-11-신규) 참조.

### 8.6 마크다운 API

| 엔드포인트             | Method | Path                            |
| ---------------------- | ------ | ------------------------------- |
| 페이지 생성 (마크다운) | POST   | `/v1/pages` (markdown 파라미터) |
| 페이지 조회 (마크다운) | GET    | `/v1/pages/{page_id}/markdown`  |
| 페이지 수정 (마크다운) | PATCH  | `/v1/pages/{page_id}/markdown`  |

**Notion-Flavored Markdown 지원 문법**:

- 표준: H1~H4, 리스트, 체크박스, 인용, 구분선, 코드 펜스, 테이블
- 확장: 수식 `$$ equation $$`, 토글 `<details>`, 콜아웃
- 미디어: 이미지, 비디오, 오디오, PDF, 파일 (커스텀 태그)
- 비지원: 북마크, 임베드, 링크 미리보기, 브레드크럼, 템플릿 → `<unknown>` 태그

**제한사항**:

- 페이지당 약 20,000 블록 레코드 한도
- 파일 URL은 pre-signed로 자동 변환 (단시간 후 만료)
- 동기화된 페이지 업데이트 불가
- Internal/Public integration 모두 사용 가능

> **Im-Nobsidian 핵심**: 마크다운 API는 블록 API 대비 훨씬 단순하며, Obsidian MD ↔ Notion 변환에 유력한 후보. 단, Notion-Flavored Markdown과 표준 Markdown 차이 처리 필요.

### 8.7 기타 2026 신규 기능

- **Workers for Agents**: 에이전트 기반 자동화 (2026-04)
- **Voice-to-Prompt**: 음성 입력으로 태스크 생성
- **Smart Meeting Notes**: AI 회의 노트 개선
- **Place 속성**: Map 뷰용 위치 속성 (읽기 전용)

---

## 9. 알려진 제한사항

### 9.1 API가 할 수 없는 것

| 항목                       | 상세                                              |
| -------------------------- | ------------------------------------------------- |
| **워크스페이스 설정 관리** | 멤버 관리, 권한 설정, 워크스페이스 설정 변경 불가 |
| **페이지 공유/권한 설정**  | API로 페이지 공유 대상 변경 불가                  |
| **포맷 전환**              | 인라인 DB ↔ 전체 페이지 DB 전환 불가              |
| **템플릿 적용**            | 기존 페이지에 템플릿 적용 불가 (생성 시에만)      |
| **뷰 분석**                | 페이지 조회 수, 방문 기록 조회 불가               |
| **실시간 협업**            | 실시간 커서, 선택 영역 등 협업 기능 없음          |
| **되돌리기 히스토리**      | 페이지 버전 히스토리 조회/복원 불가               |
| **커스텀 이모지**          | 워크스페이스 커스텀 이모지 관리 불가              |
| **링크 미리보기 생성**     | link_preview 블록 읽기만 가능, 생성 불가          |
| **Form/Button 블록**       | unsupported 타입으로 반환, 생성/수정 불가         |

### 9.2 숫자 제한

| 항목                    | 제한                                                 |
| ----------------------- | ---------------------------------------------------- |
| 한 요청 블록 중첩       | **2단계**                                            |
| 요청당 블록 수          | **1,000개** (페이로드) / **100개** (append children) |
| 페이지당 마크다운 블록  | ~20,000 블록 레코드                                  |
| Rich text 객체          | **2,000자**                                          |
| 페이지 당 속성 수       | 제한 문서화 안 됨 (실험적으로 ~100개)                |
| DB 속성 수              | 제한 문서화 안 됨                                    |
| Free 플랜 API 생성 블록 | 페이지당 **1,000 블록**                              |
| 페이로드 크기           | **500 KB**                                           |
| 파일 크기 (Free)        | **5 MiB**                                            |
| 파일 크기 (유료)        | **5 GiB**                                            |
| 파일 첨부 유효시간      | 업로드 후 **1시간**                                  |
| Free 플랜 월간 API      | **10,000 요청/월**                                   |

### 9.3 Search 제한

- 전체 워크스페이스 열거에 **최적화되지 않음**
- 인덱싱 지연 (OAuth 직후 공유된 페이지 미노출 가능)
- Search 순회 중 인덱스 변경 가능 → 결과 불안정
- 특정 DB 내 검색은 **Database Query 엔드포인트** 사용 권장
- Search 엔드포인트 자체 Rate limit ~1 req/s

---

## 10. 웹훅 상세

### 10.1 이벤트 타입 (2025-09-03+ 기준)

#### Page 이벤트 (8종)

| 이벤트                    | 설명           | 집계 |
| ------------------------- | -------------- | :--: |
| `page.created`            | 페이지 생성    |  ✅  |
| `page.content_updated`    | 블록 추가/삭제 |  ✅  |
| `page.properties_updated` | 속성 변경      |  ✅  |
| `page.moved`              | 위치 이동      |  ✅  |
| `page.deleted`            | 휴지통 이동    |  ✅  |
| `page.undeleted`          | 휴지통 복원    |  ✅  |
| `page.locked`             | 편집 잠금      |  ❌  |
| `page.unlocked`           | 편집 잠금 해제 |  ❌  |

#### Data Source 이벤트 (6종, 2025-09-03 신규)

| 이벤트                        | 설명           |
| ----------------------------- | -------------- |
| `data_source.created`         | DS 생성        |
| `data_source.content_updated` | DS 콘텐츠 변경 |
| `data_source.schema_updated`  | DS 스키마 변경 |
| `data_source.moved`           | DS 이동        |
| `data_source.deleted`         | DS 삭제        |
| `data_source.undeleted`       | DS 복원        |

#### Comment 이벤트 (3종)

| 이벤트            | 설명           | 집계 |
| ----------------- | -------------- | :--: |
| `comment.created` | 댓글/제안 생성 |  ❌  |
| `comment.updated` | 댓글 수정      |  ❌  |
| `comment.deleted` | 댓글 삭제      |  ❌  |

#### Deprecated 이벤트

- `database.content_updated` → `data_source.content_updated`
- `database.schema_updated` → `data_source.schema_updated`

### 10.2 페이로드 구조

```json
{
  "id": "event-uuid",
  "timestamp": "2026-05-08T10:30:00.000Z",
  "workspace_id": "workspace-uuid",
  "subscription_id": "subscription-uuid",
  "integration_id": "integration-uuid",
  "type": "page.content_updated",
  "authors": [{ "id": "user-uuid", "type": "person" }],
  "accessible_by": [{ "id": "bot-uuid", "type": "bot" }],
  "attempt_number": 1,
  "entity": {
    "id": "page-uuid",
    "type": "page"
  },
  "data": {
    "parent": {
      "type": "page_id",
      "page_id": "parent-page-uuid"
    }
  }
}
```

> **핵심**: 페이로드에 **변경된 콘텐츠 자체는 포함되지 않음**. 시그널만 전달되며, 실제 데이터는 API로 재조회 필요.

### 10.3 구독 설정 프로세스

1. Integration 설정 대시보드 → **Webhooks 탭**
2. **"+ Create a subscription"** 클릭
3. 웹훅 URL 입력 (SSL 필수, localhost 불가)
4. 수신할 이벤트 타입 선택
5. Notion이 검증 토큰 POST 전송:
   ```json
   { "verification_token": "secret_tMrlL1qK..." }
   ```
6. Webhooks 탭 → **"⚠️ Verify"** → 토큰 붙여넣기
7. 활성화 완료

> **제약**: 검증 후 URL 변경 불가 → 삭제 후 재생성 필요
> **현재**: 프로그래밍 방식 웹훅 CRUD API 없음 (UI 기반만)

### 10.4 전달 보장 및 재시도

| 항목          | 사양                                        |
| ------------- | ------------------------------------------- |
| 전달 목표     | **5분 이내** (대부분 1분 이내)              |
| 전달 시맨틱   | **At-most-once** (중복 없음 보장 목표)      |
| 재시도        | 최대 **8회** (지수 백오프)                  |
| 마지막 재시도 | 최초 이벤트 후 ~**24시간**                  |
| 이벤트 순서   | 보장 안 됨 → `timestamp` 필드로 재정렬 필요 |
| 집계 동작     | 짧은 시간 내 다수 변경 → 단일 이벤트로 배치 |

### 10.5 서명 검증

모든 웹훅 요청에 `X-Notion-Signature` 헤더 포함:

- HMAC-SHA256 해시 (본문, verification_token으로 서명)
- 수신 측에서 서명 재계산하여 진위 확인

```typescript
import crypto from "crypto";

function verifyNotionWebhook(body: string, signature: string, token: string): boolean {
  const expected = crypto.createHmac("sha256", token).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

---

## 11. 동기화 도구 베스트 프랙티스

### 11.1 Delta Sync 전략

#### 방법 1: 웹훅 기반 (권장)

```
[Notion 변경] → [Webhook 수신] → [변경 페이지 ID 큐잉] → [API로 최신 상태 조회] → [로컬 업데이트]
```

- 웹훅은 시그널만 → 실제 데이터는 API 재조회
- 웹훅 누락 대비 주기적 폴링 보완 (safety net)

#### 방법 2: Polling 기반 (웹훅 미사용 시)

```
[주기적 실행] → [last_edited_time 필터로 DB Query] → [마지막 동기화 이후 변경분만 조회] → [로컬 업데이트]
```

- `last_edited_time` 타임스탬프를 로컬에 저장
- 폴링 간격: 활성 시 30초~1분, 비활성 시 5~15분 (adaptive polling)

### 11.2 효율적 페이지네이션

```typescript
// 모든 변경 페이지를 delta sync
async function syncChangedPages(dataSourceId: string, lastSyncTime: string) {
  let cursor: string | undefined;

  do {
    const response = await notion.dataSources.query(dataSourceId, {
      filter: {
        timestamp: "last_edited_time",
        last_edited_time: { after: lastSyncTime },
      },
      sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
      page_size: 100,
      start_cursor: cursor,
    });

    for (const page of response.results) {
      await syncSinglePage(page);
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
}
```

### 11.3 에러 처리 패턴

| HTTP 코드 | 의미                  | 대응                                       |
| --------- | --------------------- | ------------------------------------------ |
| **400**   | validation_error      | 요청 수정 후 재시도                        |
| **401**   | unauthorized          | 토큰 갱신 또는 재인증                      |
| **403**   | restricted_resource   | capability 확인 또는 페이지 접근 권한 확인 |
| **404**   | object_not_found      | 페이지 삭제됨 또는 접근 권한 없음          |
| **409**   | conflict_error        | 충돌 해결 로직                             |
| **429**   | rate_limited          | Retry-After 헤더 존중, 지수 백오프         |
| **500**   | internal_server_error | 1~5회 재시도 (지수 백오프)                 |
| **502**   | bad_gateway           | 즉시 재시도 (1~2회)                        |
| **503**   | service_unavailable   | 30초~1분 후 재시도                         |

### 11.4 지수 백오프 구현

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5, baseDelay = 1000): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const isRetryable = [429, 500, 502, 503].includes(error.status);
      if (!isRetryable) throw error;

      // Retry-After 헤더 우선, 없으면 지수 백오프
      const retryAfter = error.headers?.["retry-after"];
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : baseDelay * Math.pow(2, attempt);

      // 랜덤 지터 (0~500ms)
      const jitter = Math.random() * 500;
      await sleep(delay + jitter);
    }
  }
  throw new Error("Unreachable");
}
```

### 11.5 배치 작업 패턴

```typescript
// 벌크 업데이트로 rate limit 소비 최소화
async function bulkUpdatePages(
  updates: Array<{ pageId: string; properties: Record<string, unknown> }>,
) {
  // 100개씩 청킹
  const chunks = chunk(updates, 100);

  for (const batch of chunks) {
    await withRetry(() =>
      notion.pages.bulkUpdate({
        pages: batch.map((u) => ({
          page_id: u.pageId,
          properties: u.properties,
        })),
      }),
    );
  }
}
```

### 11.6 Im-Nobsidian 특화 전략

1. **마크다운 API 우선**: 블록 API 대비 요청 수 대폭 절감
   - 페이지 조회: `GET /v1/pages/{id}/markdown` 1회 vs 블록 재귀 조회 N회
   - 페이지 업데이트: `PATCH /v1/pages/{id}/markdown` (update_content) 1회

2. **충돌 감지**: 양방향 동기화의 핵심
   - `last_edited_time` 비교로 충돌 감지
   - 충돌 시: 최신 우선 / 사용자 선택 / 양쪽 보존 전략

3. **증분 동기화 흐름**:

   ```
   1. 로컬 변경 감지 (Obsidian file watcher)
   2. Notion 변경 감지 (webhook 또는 polling)
   3. 충돌 확인 (양쪽 모두 변경된 경우)
   4. 충돌 없으면 방향에 따라 push/pull
   5. 동기화 상태 메타데이터 업데이트
   ```

4. **파일 동기화**:
   - Obsidian 첨부파일 → `/v1/file_uploads`로 업로드 → 블록에 첨부
   - Notion 파일 → pre-signed URL 다운로드 (URL 만료 주의)

---

## 참고 소스

- [Notion API Authentication](https://developers.notion.com/reference/authentication)
- [Notion API Authorization Guide](https://developers.notion.com/docs/authorization)
- [Notion API Rate Limits](https://developers.notion.com/reference/request-limits)
- [Notion API Block Types](https://developers.notion.com/reference/block)
- [Notion API Rich Text](https://developers.notion.com/reference/rich-text)
- [Notion API Property Types](https://developers.notion.com/reference/property-object)
- [Notion API Webhooks](https://developers.notion.com/reference/webhooks)
- [Notion API Webhook Events](https://developers.notion.com/reference/webhooks-events-delivery)
- [Notion API Search Limitations](https://developers.notion.com/reference/search-optimizations-and-limitations)
- [Notion API Capabilities](https://developers.notion.com/reference/capabilities)
- [Notion API File Upload](https://developers.notion.com/reference/file-upload)
- [Notion API Markdown Content](https://developers.notion.com/guides/data-apis/working-with-markdown-content)
- [Notion API Changelog](https://developers.notion.com/page/changelog)
- [Notion API 2025-09-03 Upgrade Guide](https://developers.notion.com/docs/upgrade-guide-2025-09-03)
- [Notion API Updates 2026 (Fazm)](https://fazm.ai/blog/notion-api-updates-2026)
- [Notion API Rate Limits 2026 (Fazm)](https://fazm.ai/blog/notion-api-rate-limits-2026)
- [Notion Webhooks Complete Guide (SES)](https://softwareengineeringstandard.com/2025/08/31/notion-webhooks/)
- [Notion API Architecture Guide (Truto)](https://truto.one/blog/how-to-integrate-with-the-notion-api-architecture-guide-for-b2b-saas)
