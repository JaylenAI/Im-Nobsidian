---
type: concept
title: "무손실 동기화 전·후처리 파이프라인 설계"
created: 2026-05-30
updated: 2026-05-30
status: active
tags: ["project/im-nobsidian", "type/architecture", "sync/fidelity"]
related:
  [
    "[[NOTION_API_LOSSLESS_SYNC]]",
    "[[SYNC_FIDELITY_GOAL]]",
    "[[CONVERSION_FEASIBILITY]]",
    "[[NOTION_API_RESEARCH]]",
  ]
summary: "Notion 하드 리밋·손실 지점을 전·후처리 파이프라인 단계와 preserve marker로 흡수하여 I1~I12 무손실 불변식을 만족시키는 종합 설계"
---

# 무손실 동기화 전·후처리 파이프라인 설계

> 본 문서는 4종 리서치 추출(`NOTION_API_RESEARCH.md`, `OBSIDIAN_API_RESEARCH.md`,
> `CONVERSION_FEASIBILITY.md`, `NOTION_API_LOSSLESS_SYNC.md`)을 종합하여,
> Notion REST API의 **하드 리밋**과 **무손실 표현 불가 지점**을 전처리(MD→Notion)·후처리(Notion→MD)
> 파이프라인 단계로 흡수하는 방법을 정의한다.
> 무손실의 기준이 되는 불변식 **I1~I12** 의 정의 원본은 `[[SYNC_FIDELITY_GOAL]]`(SSOT)에 있고,
> 본 문서는 각 워크어라운드를 해당 불변식에 매핑한다.
>
> **표기 규칙**
>
> - **[검증됨]** — 리서치 evidence로 직접 뒷받침되는 사실.
> - **[가설]** — evidence로 직접 확인되지 않은 추정. 설계 판단/구현 권고에 한함.
> - 모든 수치·제약은 evidence 출처(섹션/표 위치)를 함께 표기한다.

---

## 1. 목표·범위

### 1.1 목표

- Obsidian Markdown ↔ Notion 간 **양방향 무손실 동기화**를 위해, Notion API의 구조적 제약과
  표현력 격차를 **파이프라인 단계 + preserve marker**로 흡수한다.
- "무손실"의 운영적 정의는 `[[SYNC_FIDELITY_GOAL]]` 의 불변식 **I3**: _블록·속성·인라인span·첨부
  개수 delta = 0, 조용한 유실(silent drop) 금지_. 본 설계의 모든 워크어라운드는 이 delta=0 을
  깨지 않는 것을 목표로 한다.

### 1.2 범위

| 포함                                                              | 제외                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| MD→Notion 전처리(청킹·평탄화·분할·마커 주입·첨부 업로드)          | 충돌 병합 알고리즘 상세(I8 — `[[CONFLICT_RESOLUTION]]`) |
| Notion→MD 후처리(마커 복원·callout·속성→frontmatter·`.base`·링크) | 동기화 스케줄러/큐 엔진 상세(`[[SYNC_ENGINE_DESIGN]]`)  |
| 하드 리밋 표 + 손실 지점 워크어라운드 매트릭스                    | 플러그인 UIUX 렌더(I9 — `[[SYSTEM_ARCHITECTURE]]`)      |
| preserve marker 카탈로그(SSOT 문법)                               | 크래시 복구 `pending_operations`(I12 — 엔진 측)         |

### 1.3 두 갈래 push 경로 (전처리 분기의 전제)

리서치(`NOTION_API_LOSSLESS_SYNC.md §1`)에서 **검증된** 핵심 사실: 기본 push 경로
`preferMarkdownApi=true` 는 **100블록·2단계 중첩 제한을 서버측에서 우회**한다(탭 들여쓰기로
무제한 깊이). 따라서 본 파이프라인은 두 경로를 구분한다. **[검증됨]**

- **경로 A (Markdown API, 기본)** — 100블록/2단계 제한 자동 우회. 청킹·평탄화의 주 부담이 서버에 있음.
- **경로 B (Blocks API 폴백)** — 마커 봉합(dual-pass)·재귀 deep-append 등 클라이언트가 직접 제약을 처리.

> 따라서 아래 3장의 청킹/평탄화 단계는 **경로 B에서 필수**, 경로 A에서는 안전망(방어)으로 동작한다.

---

## 2. Notion 하드 리밋 표 (제약·수치·근거)

> 출처 약어: `N`=`NOTION_API_RESEARCH.md`, `L`=`NOTION_API_LOSSLESS_SYNC.md`,
> `C`=`CONVERSION_FEASIBILITY.md`, `O`=`OBSIDIAN_API_RESEARCH.md`.

### 2.1 요청 구조 한계

| 제약                    | 값                                           | HTTP/거동              | 근거              |
| ----------------------- | -------------------------------------------- | ---------------------- | ----------------- |
| append children 블록 수 | **100개/요청**, 초과 시 거부                 | 거부                   | N §2.2/§9.2, L §1 |
| 한 요청 블록 중첩 깊이  | **2단계**, 더 깊으면 거부/드롭               | 거부/드롭              | N §2.2 핵심, L §1 |
| payload 블록 수         | **1,000개**                                  | 청크 필요              | N §3.3/§9.2, L §1 |
| 본문 바이트             | **500 KB** 초과 시 413                       | **비재시도 하드 실패** | N §3.3, L §1      |
| URL 길이                | **2,000자**                                  | 검증                   | N §3.3            |
| 페이지네이션 page_size  | 기본 10, **최대 100**                        | start_cursor 루프      | N §4.2, L §1      |
| 벌크 페이지 업데이트    | 최대 **100개/요청** (`PATCH /v1/pages/bulk`) | —                      | N §2.1/§8.3       |

### 2.2 텍스트·속성 값 한계

| 제약                                  | 값                                                       | 근거              |
| ------------------------------------- | -------------------------------------------------------- | ----------------- |
| rich_text 객체 1개 문자 수            | **2,000자/객체**, 초과 시 검증오류                       | N §3.3/§6.5, L §1 |
| 블록 당 rich_text 배열                | **100개 객체** → 블록 당 최대 ~200,000자 (2,000×100)     | N §6.5            |
| 수식(equation) 길이                   | **1,000자**                                              | N §3.3, L §1      |
| multi_select 옵션 수                  | **100개**                                                | N §3.3            |
| relation 관련 페이지 수(쓰기)         | **100개**                                                | N §3.3            |
| relation 속성 cap(page-retrieve 읽기) | **25개**, 초과 시 **무음 절단**(`has_more`), 순서 미보장 | L §4.3            |
| people mention 수                     | **100명**                                                | N §3.3            |
| 이메일/전화 길이                      | 각 **200자**                                             | N §3.3            |

### 2.3 페이지·플랜 한계

| 제약                    | 값                                     | 거동                                             | 근거              |
| ----------------------- | -------------------------------------- | ------------------------------------------------ | ----------------- |
| 페이지 블록 총량        | **~20,000 블록 레코드**                | retrieve 시 `truncated:true`+`unknown_block_ids` | N §8.6/§9.2, L §1 |
| Free 플랜 API 생성 블록 | 페이지당 **1,000 블록**                | —                                                | N §9.2            |
| Free 플랜 월간 API 요청 | **10,000 요청/월**                     | —                                                | N §3.1/§9.2       |
| 페이지/DB 속성 수       | 문서화 안 됨(실험적 ~100개) **[가설]** | —                                                | N §9.2            |

### 2.4 Rate limit / 재시도

| 제약               | 값                                                 | 근거                   |
| ------------------ | -------------------------------------------------- | ---------------------- |
| 지속 속도          | **3 req/s** (connection 당, 모든 플랜 동일)        | N §3.1, L §1, C, O §14 |
| 버스트             | 유휴 시 버킷 최대 **10** 충전, 10개 연속 가능      | N §3.1                 |
| Search 엔드포인트  | **~1 req/s** (더 엄격), 순회 중 인덱스 변경 가능   | N §3.1/§9.3            |
| 재시도 가능 status | **409 / 502 / 503 / 504** (429는 Retry-After 준수) | L §1                   |
| 재시도 불가 status | **400 / 413 / 401 / 403 / 404**                    | L §1                   |

### 2.5 파일 업로드 / URL 만료

| 제약                        | 값                                                   | 근거                         |
| --------------------------- | ---------------------------------------------------- | ---------------------------- |
| 첨부 크기(Free)             | **5 MiB/파일**                                       | N §2.6/§9.2                  |
| 첨부 크기(유료)             | **5 GiB/파일**                                       | N §2.6/§9.2                  |
| 멀티파트 임계값             | **20 MiB 초과** 시 멀티파트 필수(파트당 5~20 MiB)    | N §2.6, L §1/§5              |
| 업로드 후 첨부 유효시간     | **1시간** 내 attach(미첨부 시 만료)                  | N §2.6/§9.2, L §5            |
| Notion-hosted 파일 URL 만료 | **1시간** signed S3 링크 — 캐시 금지, 만료 시 재조회 | N §8.6/§11.6, L §5, C B-6, O |
| 파일명 길이                 | **900 byte** 준수                                    | L §5                         |

### 2.6 Obsidian 측 운영 한계 (전·후처리 타이밍에 영향)

| 제약                                | 값                                                                 | 근거 |
| ----------------------------------- | ------------------------------------------------------------------ | ---- |
| `vault.process()/modify()` 디바운스 | 파일 편집 후 **~2초 이내** 호출 시 실패 가능(requestSave debounce) | O §2 |
| MetadataCache 비동기                | 수정 직후 캐시 읽으면 **stale 값** 반환 가능                       | O §3 |
| 외부 rename 처리                    | Obsidian이 **delete+create 쌍**으로 처리 → 파일 추적 끊김 위험     | O §2 |
| `Notice` 표시                       | 기본 5초, `0` 전달 시 수동 닫기까지 유지                           | O §5 |
| manifest version                    | SemVer `x.y.z`, 릴리스 태그와 정확히 일치(`v` 접두어 없이)         | O §1 |

---

## 3. MD→Notion 전처리 파이프라인

> 입력: Obsidian MD(frontmatter + 본문 + 첨부). 출력: Notion API 호출 시퀀스(생성/append/upload).
> 단계는 순서대로 적용한다. **경로 A**(Markdown API 기본)에서 청킹/평탄화는 안전망, **경로 B**(Blocks
> 폴백)에서는 필수. (근거: L §1 중요/§7)

### 단계 0 — 마커 환원 & 중복 제거

`<!--ntn:...-->` / `<!--obs:...-->` preserve marker를 **실제 Enhanced-Markdown 태그로 환원한 뒤
중복 제거**한다. (근거: L §7 "전처리는 ntn: 마커를 실제 태그로 환원한 뒤 중복 제거")

### 단계 1 — 인라인/위키링크/서식 정규화

| 입력               | 변환                                           | 보존 마커                        | 근거                                             |
| ------------------ | ---------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| `<u>x</u>`         | `<span underline="true">x</span>` 완전 가역    | 불필요                           | L §3 (**I3 — 현재 push 시 strip 됨, 수정 대상**) |
| `==x==`            | `yellow_bg` 결정적 매핑                        | 나머지 17색 `<!--ntn:c=COLOR-->` | L §3                                             |
| `[[Note]]`         | `<mention-page url>` (UUID는 idmap 해석)       | `<!--ntn:page=ID-->`             | L §3, C B-7                                      |
| `[[Page#Heading]]` | 텍스트 링크로 **강등**(heading mention 미지원) | —                                | C B-7 (손실)                                     |
| `![[embed]]`       | `mention-page` / `![](signedurl)`              | `<!--ntn:embed kind=...-->`      | L §3                                             |
| `[^1]` 각주        | 인라인/Footnotes 토글                          | `<!--obs:fn id=1-->`             | L §3                                             |
| `#tag`             | 페이지 multi-select 속성                       | `<!--obs:tag-->`                 | L §3                                             |
| `# H {color="C"}`  | Enhanced-MD 헤딩 색                            | `<!--ntn:hcolor=C-->`            | L §3                                             |

> **mention UUID 의존성**: mention 생성은 대상 UUID가 필요하다. `idmap(경로↔page_id)` 가 없으면
> user/agent mention 이 평문으로 강등된다(손실). idmap 유지는 **필수**. (근거: L §3)

### 단계 2 — 콜아웃 매핑 (Obsidian → Notion)

```text
[!warning]- 접힌 콜아웃
```

→ Notion callout(아이콘 ⚠️ + `yellow_background`). 13종 타입을 아이콘+색으로 매핑
(note/info/tip/important/warning/danger/success/question/failure/bug/example/quote/abstract 계열).
Notion callout은 **접기 미지원**이므로 foldable 상태는 caption 메타로 보존:

```text
im-nobsidian:callout-type:warning:foldable:collapsed
```

(근거: C B-2, O 색상매핑 13종)

### 단계 3 — frontmatter → Notion Properties 타입 매핑

| Obsidian frontmatter      | Notion property                                   | 근거              |
| ------------------------- | ------------------------------------------------- | ----------------- |
| string                    | select / rich_text                                | C B-4             |
| string[]                  | multi_select                                      | C B-4             |
| number                    | number                                            | C B-4             |
| boolean                   | checkbox                                          | C B-4             |
| 날짜                      | date                                              | C B-4             |
| URL                       | url                                               | C B-4             |
| wikilink 배열             | relation (idmap)                                  | C B-4             |
| **중첩 객체 / 매핑 불가** | `_im_nobsidian_meta` (rich_text, **JSON 직렬화**) | C B-4 (손실 보존) |

### 단계 4 — rich_text 2,000자 분할 (블록 1개 유지)

rich_text run이 2,000자를 초과하면 **동일 annotation을 가진 다중 세그먼트로 분할**하되 **블록은
1개로 유지**한다. 배열이 100객체를 넘으면 블록 분리. (근거: L §1, N §3.3/§6.5)

```ts
// 의사코드: 2000자 경계 분할, annotation 보존
function splitRichTextRun(run: RichText): RichText[] {
  const out: RichText[] = [];
  for (let i = 0; i < run.text.length; i += 2000) {
    out.push({ ...run, text: { ...run.text, content: run.text.content.slice(i, i + 2000) } });
  }
  return out; // 같은 annotations 유지 → 블록 1개 내 다중 run
}
```

### 단계 5 — 값 한계 검증 (URL/equation/email/phone/multi_select/relation)

URL 2,000자 / equation 1,000자 / email·phone 200자 / multi_select·relation·people 100개 초과 시
입력 검증 후 트렁케이트 또는 거부(silent drop 금지, 사용자 로그). (근거: N §3.3)

### 단계 6 — 블록 100개 청킹 (경로 B)

100개 초과 자식 블록은 100개씩 분할하여 다중 `PATCH /v1/blocks/{id}/children` 으로 전송.
payload 블록 1,000 초과 시 추가 청크. (근거: N §2.2/§9.2, L §1)

```text
children = [b0 … b249]
→ append(parent, b0..b99)
→ append(parent, b100..b199)   # 순서/멱등성 주의 (I12)
→ append(parent, b200..b249)
```

### 단계 7 — 2단계 초과 중첩 평탄화 (재귀 deep-append, 경로 B)

한 요청 2단계 한계를 넘는 구조(toggle > column > list 등)는 **2단계까지 전송 → `resp.results[].id`
포착 → 3단계+ 를 부모 ID 참조로 재귀 append**. (근거: N §2.2 핵심, L §1)

```text
1) append(page, [toggle{ children:[column_list{ children:[column] }] }])  // 2단계까지
2) capture toggleId, columnListId, columnId from resp.results
3) append(columnId, [list…])                                              // 3단계+ 재귀
```

### 단계 8 — 500KB/413 청크 분할

본문 바이트가 500KB(413 비재시도)에 근접하면 **column-0 블록 경계로 청크 분할**(Markdown API
경로에도 적용). (근거: L §1)

### 단계 9 — 첨부 업로드 (1시간 attach window)

- 로컬 파일: `POST /v1/file_uploads`, **>20 MiB 멀티파트**(파트당 5~20 MiB), **1시간 내 attach**.
- 원격 파일: `mode:"external_url"` (블록 갱신은 file_upload 불가 → external URL 필요).
- 5 MiB(Free)/5 GiB(유료) 캡, 900 byte 파일명, **SHA-256 해시 기반 중복 방지**.

(근거: N §2.6, L §5, C B-6)

### 단계 10 — children 미지원 블록 정리

`code`/`equation` 블록은 children 미지원 → children 부착 시도 제거. (근거: N §5.1)

### 단계 11 — 마커 봉합 (dual-pass, 경로 B 복원)

Markdown API가 렌더하지 않는 블록(bookmark/embed/breadcrumb/link_preview/template)은
**마커 파싱 → Markdown API 본문 작성 후 2차 Blocks-API append(`after_block` 위치 지정)** 로 복원.
(근거: L §2-A)

### 단계 12 — 데이터소스 신모델 & 파괴적 쓰기 금지

- 페이지 생성/relation parent는 **`data_source_id`** 사용(2025-09-03 신모델), `database_id` 직접 사용 금지. (근거: N §8.2)
- `child/markdown` 파라미터 상호 배타 — 둘 중 하나만 지정. (근거: N §2.1)
- **파괴적 쓰기 금지**: `update_content`(타겟 검색-치환) 기본, `replace_content` 는 신규/전체재작성
  옵트인에만, `allow_deleting_content` 기본 false. (근거: L §0-5)

### 단계 13 — Obsidian 측 안전 처리

- frontmatter 수정은 `fileManager.processFrontMatter()` 로 atomic 처리(YAML 손상 방지). (근거: O §3)
- 모든 경로는 `normalizePath()` 정규화. (근거: O §12)
- 파일 편집 후 ~2초 내 `vault.process()` 호출 금지(디바운스). (근거: O §2)

---

## 4. Notion→MD 후처리 파이프라인

> 입력: Notion 페이지/DB(blocks + properties + views). 출력: Obsidian MD + 첨부 + `.base`/사이드카.

### 단계 0 — retrieve 무결성 검사 (거대 페이지 방어)

페이지 retrieve 시 `truncated:true` / `unknown_block_ids` 를 **반드시 검사**한다. 미검사 시
~20,000 블록 초과 거대 페이지에서 **무음 손실** 발생. (근거: N §8.6, L §1)

### 단계 1 — Markdown API 사각지대 봉합 (dual-pass)

`retrieveMarkdown()` 은 bookmark/embed/breadcrumb/link_preview/template 를 **무음 소실**시킨다.
`blocks.children.list()` 병행 패스로 탐지 → 위치에 보존마커 삽입:

```html
<!--ntn:bookmark id="abc" url="https://…" caption="…"-->
```

(근거: L §0-2/§2-A)

### 단계 2 — 인라인 서식/마커 복원

| Notion                    | Obsidian                  | 마커                               | 근거        |
| ------------------------- | ------------------------- | ---------------------------------- | ----------- |
| `<span underline="true">` | `<u>` 가역                | 불필요                             | L §3        |
| `yellow_bg`               | `==x==` highlight         | —                                  | L §3, C B-8 |
| 그 외 17색                | (HTML span 유지)          | `<!--ntn:c=COLOR-->…<!--/ntn:c-->` | L §3        |
| page mention              | `[[Note]]` (idmap 역참조) | `<!--ntn:page=ID-->`               | L §3, C B-7 |
| 날짜 mention              | 날짜 텍스트               | `<!--ntn:date …-->`                | L §3        |

> **overlapping annotation 병합**: Notion rich_text annotation 집합은 독립이므로, 역방향에서
> **동일 annotation 연속 span 을 병합(coalesce)** 해 diff churn(I5)을 최소화한다. (근거: L §3)

### 단계 3 — callout / column / toggle 복원

| Notion             | Obsidian                          | 보존                                                                    | 근거    |
| ------------------ | --------------------------------- | ----------------------------------------------------------------------- | ------- |
| callout            | `[!type]` (아이콘/색 역매핑)      | foldable caption 메타                                                   | C B-2   |
| column_list/column | callout 기반 `[!col]`/`[!col-md]` | `%% im-nobsidian:column_list:start:columns=2:widths=1,1 %%` … `:end %%` | C B-9   |
| toggle heading     | `[!toggle]-` callout, level 보존  | `%% im-nobsidian:toggle_heading:level=2 %%`                             | C B-10  |
| table_of_contents  | Obsidian Outline 코어             | `%% im-nobsidian:table_of_contents %%`                                  | C A등급 |
| breadcrumb         | 폴더 구조 + frontmatter           | preserve marker                                                         | C A등급 |

### 단계 4 — 첨부 즉시 다운로드 (1시간 만료 대응)

Notion image/file 블록 URL은 **1시간 만료 signed S3 링크 — 캐시 금지**. 후처리 시점에 `expiry_time`
검사 → 만료 임박/경과 시 **페이지 재조회로 새 URL 발급 → 즉시 다운로드** → `attachments/` 저장,
SHA-256 중복 방지. `{notion_kind, original_name, external_url?}` 기록. (근거: N §8.6/§11.6, L §5, C B-6)

> 비교 기준은 **content_hash** (signed URL 만료/변동 무시) — 불변식 I6.

### 단계 5 — 속성 → frontmatter 역매핑

| Notion property                 | frontmatter                                                       | 근거                 |
| ------------------------------- | ----------------------------------------------------------------- | -------------------- |
| date range                      | `_start` / `_end` 분리                                            | C DB-2               |
| status                          | 값 + `_group`(not_started/active/complete)                        | C DB-2               |
| unique_id                       | `notion_uid` / `_notion_uid`                                      | C DB-2, L §4.2       |
| relation                        | `[[wikilink]]` 배열 (self-relation은 blocks/blocked_by)           | C DB-2/DB-4          |
| files                           | `attachments/…` 로컬 경로                                         | C DB-2               |
| created*time/by, last_edited*\* | `_notion_created` 등 **읽기전용 미러**(역방향 쓰기 제외)          | L §4.2/§6-8 (**I7**) |
| rollup                          | Dataview 집계 + `_rollup_*` 캐시                                  | C DB-5               |
| formula                         | Bases formula + 불가 함수는 `_formula_*` 캐시 + `_formula_source` | C DB-6               |

### 단계 6 — relation 25-cap 재조회

page-retrieve가 relation을 **25개로 무음 절단**(`has_more`)하므로
**`Retrieve page property item`(100/page)** 으로 재조회해야 완전. **순서 미보장** 유의(현재 코드
미처리, 수정 대상). (근거: L §4.3 — **I4**)

### 단계 7 — DB → `.base` + 사이드카 생성

- **구조 매핑**: 1 DB = 1 folder, 1 row = 1 `.md`, 1 column = 1 frontmatter field. (근거: C DB-1)
- **`.base` 를 뷰 권위원(authoritative)** 으로: table→table, gallery→cards, list→list;
  board/calendar/timeline → cards+groupBy/정렬 table 로 **degrade + 뷰 degrade 마커**. (근거: L §4.4, C DB-3)
- **멀티 데이터소스**: data source 당 폴더 1 + `.base` 1. 현재 client가 `data_sources[0]` 만 사용 →
  2번째+ 소스 소실(수정 대상). 컨테이너 관계는 사이드카에 `database_id ↔ data_sources[]` 기록.
  (근거: L §4.1 — **I4**)
- **표현 불가 메타데이터 → 사이드카** `<db>.notion.json`: 뷰 레이아웃·status groups·select option
  id/color·rollup/formula 정의·dual-relation synced name·멀티 데이터소스 매핑. (근거: L §0-3)
- **`_schema.yml`**: `database_id`, properties(groups/options), views(id/name/type/file),
  `last_synced`. (근거: C DB-7)

```text
MyDB/
├── _schema.yml
├── MyDB.base                 # 뷰 권위원
├── MyDB.notion.json          # 사이드카(표현 불가 메타)
├── _views/                   # (보조) board→Kanban, calendar→Dataview CALENDAR 등
└── Row-1.md … Row-N.md
```

### 단계 8 — Cover/Icon/Embed 복원

- Cover/Icon → frontmatter `banner`/`banner_icon` + `im_nobsidian_cover`/`im_nobsidian_icon` 원본
  보존, 커버는 `attachments/covers/` 다운로드. (근거: C B-11)
- Embeds → `<iframe>` 또는 `[제목](URL)`/`![[file.pdf]]`, 원본 embed 타입 마커 보존:
  `%% im-nobsidian:embed:type=video:source=youtube:url=… %%`. (근거: C B-12)

### 단계 9 — 미지 블록 graceful degrade

미지 블록은 `unsupported.block_type` / `<unknown alt>` 기반 **데이터 주도** degrade. 원래 타입을
보존마커로 봉합하고 `replace_content` 금지·`update_content` 사용. (근거: L §7, N §5.1 #35)

### 단계 10 — 링크 해결 & 요청 수 절감

- 페이지 조회는 `GET /v1/pages/{id}/markdown` **1회**로 블록 재귀 조회 N회 대비 요청 수 절감.
  (근거: N §11.6)
- DB 스키마는 신모델상 `GET /v1/databases/{id}` 가 data_source 목록만 반환하므로
  `GET /v1/data_sources/{id}` 로 후속 조회. (근거: N §8.2)

### 단계 11 — 비가역 손실 가시화

`§6` 비가역 손실 항목은 **침묵 폐기 금지** — sync 당 "lossy 필드" 요약을 사용자에게 표시한다.
(근거: L §0-6/§6 결론, O §5 Notice)

---

## 5. 손실 지점별 워크어라운드 매트릭스 (리밋 → 전략 → 불변식 I1~I12)

> 불변식 정의 SSOT: `[[SYNC_FIDELITY_GOAL]]`. 핵심:
> I1=MD 라운드트립 deep-equal, I2=Notion 라운드트립, I3=무손실/marker/개수delta=0,
> I4=DB 충실도(뷰·멀티소스), I5=멱등성(churn 0), I6=첨부 content_hash, I7=Bases 렌더/식별필드,
> I8=충돌 3-way, I9=UIUX, I10=삭제 전파, I11=API 구조 제약 무손실, I12=크래시 복구.

### 5.1 하드 리밋 → 워크어라운드

| 리밋                                      | 전략                                                       | 불변식            |
| ----------------------------------------- | ---------------------------------------------------------- | ----------------- |
| append 100블록 초과                       | 100개 배치 청킹(경로 B), 경로 A는 서버 우회                | **I11**           |
| 2단계 중첩 초과                           | 재귀 deep-append(`results[].id` 포착), 경로 A는 서버 우회  | **I11**           |
| payload 1,000블록 / 500KB·413             | column-0 경계 청크 분할(MD API에도 적용)                   | **I11**           |
| rich_text 2,000자                         | 다중 세그먼트 분할(블록 1개 유지)                          | **I1·I3**         |
| relation 25-cap(읽기 무음 절단)           | `Retrieve page property item` 100/page 재조회              | **I4**            |
| 페이지 ~20,000 블록                       | retrieve 시 `truncated`/`unknown_block_ids` 검사           | **I3·I11**        |
| rate limit 3 req/s / Search ~1 req/s      | `async-sema(3)` 스로틀, Search 보수적, 429 Retry-After     | **I12**(중복방지) |
| 첨부 1시간 만료                           | `expiry_time` 검사→재조회→즉시 다운로드, content_hash 비교 | **I6**            |
| 파일 1시간 attach window / 20MiB 멀티파트 | 업로드 후 1시간 내 attach, 멀티파트, SHA-256 중복방지      | **I6**            |

### 5.2 표현/생성 불가 손실 → 워크어라운드

| 손실 지점                                                                      | 전략                                                     | 불변식               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------- |
| MD API 무음 소실(bookmark/embed/breadcrumb/link_preview/template)              | dual-pass 탐지 + `<!--ntn:bookmark…-->` 봉합             | **I3**               |
| read-only 블록(link_preview unfurl / template / button / form / meeting_notes) | `<unknown alt>` 보존마커, 재생성 시도 안 함              | **I3**               |
| underline push 시 strip                                                        | `<span underline="true">` 완전 가역 변환                 | **I3**(현 수정 대상) |
| 17색(yellow_bg 외)                                                             | `<!--ntn:c=COLOR-->` 마커, span 병합                     | **I3**               |
| user/agent mention 평문 강등                                                   | idmap(경로↔page_id) 유지, `<!--ntn:page=ID-->`           | **I3**               |
| synced_block 본문 갱신 불가                                                    | 편집 시 **skip-and-warn**(무음 손실 금지)                | **I3·I10**           |
| table table_width 불변                                                         | 컬럼 수 변경 시 delete+recreate                          | **I4**               |
| rollup/place/시스템속성 쓰기 불가                                              | frontmatter 읽기전용 미러(`_notion_*`), 역방향 쓰기 제외 | **I7**               |
| place(지오) read null                                                          | 비가역 — lossy 요약 표시                                 | **I7**(비가역)       |
| 뷰 정의 API 노출 제로(board/calendar/gallery/timeline)                         | `.base` degrade + 사이드카 보존 + degrade 마커           | **I4·I7**            |
| status group 재구성 불가                                                       | 기본 그룹만 생성 + 사이드카 보존                         | **I4**               |
| unique_id/created_time 재생성 시 리셋                                          | frontmatter 미러(`_notion_uid`/`_notion_created`)        | **I7**               |
| 멀티 데이터소스(현 `[0]`만)                                                    | data source 당 폴더+`.base`, 사이드카 매핑               | **I4**               |
| heading 앵커 `[[Page#Heading]]`                                                | 텍스트 링크 강등(비가역) — lossy 요약                    | **I1**(degrade)      |
| Dataview/Templater/Comments/Canvas                                             | 코드블록·toggle·mermaid 보존 + `im-nobsidian:preserve:*` | **I3**               |
| Block Reference 임베드(synced 한계)                                            | synced 시도→실패 시 callout+스냅샷, 원본 마커            | **I3**               |
| Formula 불가 함수 / Rollup 라이브                                              | 결과 캐시 + 원본 보존(라이브 손실 = 비가역)              | **I4·I7**(비가역)    |
| 인라인 코멘트 앵커·resolved·새 토론                                            | 비가역 — 동기화 제외(기본), lossy 요약                   | (비가역)             |
| 외부 rename = delete+create                                                    | 추적 끊김 — idmap/`notion_uid` 기반 재연결               | **I10**              |
| MetadataCache stale                                                            | 수정 직후 캐시 읽기 회피, `processFrontMatter` atomic    | **I5**               |

### 5.3 미커버 불변식 노트

- **I2**(Notion 라운드트립), **I5**(멱등성/churn 0), **I8**(3-way 충돌), **I9**(UIUX),
  **I12**(크래시 복구)는 본 파이프라인이 *전제·기반*을 제공하지만, 알고리즘 본체는
  `[[SYNC_ENGINE_DESIGN]]`·`[[CONFLICT_RESOLUTION]]`·`[[SYSTEM_ARCHITECTURE]]` 소관이다. **[가설]**
  (본 매트릭스는 손실 흡수 측면만 매핑)

---

## 6. preserve marker 카탈로그

### 6.1 단일 SSOT 문법 (근거: L §7)

```text
<!--ntn:KEY=VALUE …-->     # Notion 기원 메타 (인라인/블록 봉합)
<!--obs:KEY=VALUE-->       # Obsidian 기원 메타
<!--/ntn:KEY-->            # span 류 범위 종료
%% im-nobsidian:… %%       # Obsidian 미리보기 비가시 블록 마커(callout/column/embed/synced)
```

> HTML 주석(`<!--…-->`)은 **Obsidian 미리보기 비가시 + 편집기 생존 + Notion 마크다운 무시**를
> 동시에 만족하므로 봉합 매체로 채택. `%% … %%` 는 Obsidian 코멘트(미리보기 비가시).

### 6.2 카탈로그 표

| 케이스                                    | 마커 형식                                                                    | 근거              |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ----------------- |
| 색상(17색, yellow_bg 외)                  | `<!--ntn:c=COLOR-->…<!--/ntn:c-->`                                           | L §3              |
| page mention 대상 ID                      | `<!--ntn:page=ID-->`                                                         | L §3              |
| embed 종류                                | `<!--ntn:embed kind=…-->`                                                    | L §3              |
| 날짜 mention                              | `<!--ntn:date …-->`                                                          | L §3              |
| heading 색상                              | `<!--ntn:hcolor=C-->`                                                        | L §3              |
| Obsidian 각주                             | `<!--obs:fn id=1-->`                                                         | L §3              |
| Obsidian 태그                             | `<!--obs:tag-->`                                                             | L §3              |
| MD API 미렌더(bookmark 등)                | `<!--ntn:bookmark id="…" url="…" caption="…"-->`                             | L §2-A            |
| 생성 불가 블록(button/form/meeting_notes) | `<unknown url="…" alt="…"/>` (그대로 보존)                                   | L §2-B/§7         |
| Column Layout                             | `%% im-nobsidian:column_list:start:columns=2:widths=1,1 %%` … `:end %%`      | C B-9             |
| Toggle Heading                            | `%% im-nobsidian:toggle_heading:level=2 %%` → 복원 시 `is_toggleable:true`   | C B-10            |
| Synced Block                              | `%% im-nobsidian:synced-block:abc123:source %%` + `_synced_blocks/abc123.md` | C C-4, N §5.1 #29 |
| Embed(영상 등)                            | `%% im-nobsidian:embed:type=video:source=youtube:url=… %%`                   | C B-12            |
| 목차(TOC)                                 | `%% im-nobsidian:table_of_contents %%`                                       | C A등급           |
| Callout foldable                          | caption `im-nobsidian:callout-type:warning:foldable:collapsed`               | C B-2             |
| Dataview 쿼리                             | caption `im-nobsidian:preserve:dataview`(정적 테이블 무시·원본 복원)         | C C-1             |
| Templater 템플릿                          | caption `im-nobsidian:preserve:templater`(감지 `/<%[\s\S]*?%>/g`)            | C C-2             |
| Obsidian Comments                         | caption `im-nobsidian:preserve:comment`(toggle 보존)                         | C C-5             |
| Canvas                                    | caption `im-nobsidian:preserve:canvas:project-plan`                          | C C-6             |
| Block Reference                           | caption `im-nobsidian:preserve:block-ref:note^block-id` → `![[…]]` 복원      | C C-3             |

### 6.3 마커 예시 (라운드트립)

```markdown
<!-- Notion 17색 보존 -->

이건 <!--ntn:c=red-->빨강 텍스트<!--/ntn:c-->입니다.

<!-- MD API 미렌더 bookmark 봉합 -->
<!--ntn:bookmark id="2f1…" url="https://example.com" caption="레퍼런스"-->

%% im-nobsidian:column_list:start:columns=2:widths=1,1 %%

> [!col]
> 왼쪽 컬럼
> [!col]
> 오른쪽 컬럼
> %% im-nobsidian:column_list:end %%
```

---

## 7. 미해결 갭·후속 과제

### 7.1 비가역 손실(원천 불가 — lossy 요약으로만 가시화) (근거: L §6)

| 항목                                             | 사유                                        |
| ------------------------------------------------ | ------------------------------------------- |
| 인라인 코멘트 앵커(텍스트 범위)·resolved 코멘트  | API 비노출                                  |
| link_preview 네이티브 unfurl 재생성              | unfurl 통합 전용 read-only                  |
| 새 인라인 토론 시작                              | API 미지원                                  |
| 저장된 뷰 정의/레이아웃(board/calendar/timeline) | database object 스키마에 뷰 정의 전무       |
| button 속성/블록                                 | page-property-values 부재                   |
| place(지오) 값                                   | read 시 null                                |
| status group 재구성                              | 기본 그룹만 생성 가능                       |
| created_time/by·unique_id 원본값                 | 재생성 시 리셋(frontmatter 미러는 인간값만) |
| `[[Page#Heading]]` 앵커                          | heading mention 미지원 → 텍스트 링크 강등   |

### 7.2 코드 수정 대상 (리서치에서 "수정 대상"으로 명시)

| 항목                                              | 불변식 | 근거         |
| ------------------------------------------------- | ------ | ------------ |
| underline push 시 strip → 가역 변환               | I3     | L §3 (#47)   |
| 멀티 데이터소스 `data_sources[0]` 만 사용         | I4     | L §4.1 (#45) |
| read-only 식별/감사 필드 frontmatter 미러링       | I7     | L §4.2 (#46) |
| relation 25-cap 페이지네이션 미처리               | I4     | L §4.3       |
| 500KB/413 청킹 + truncated/unknown_block_ids 처리 | I11    | L §1         |
| 블록 폴백 재귀 deep-append                        | I11    | L §1         |
| dual-pass bookmark/embed/breadcrumb 봉합          | I2·I3  | L §2-A       |

### 7.3 검증/운영 리스크 (후속 검토 필요) **[가설]**

- **Free 플랜 월 10,000 요청** 한도가 대용량 볼트 초기 풀 동기화에서 병목이 될 수 있음 → 증분
  동기화·요청 합산(`pages/{id}/markdown` 1회) 전략의 정량 검증 필요. (근거 수치: N §3.1)
- **Search 인덱싱 지연/순회 중 변경**으로 전수 열거 누락 위험 → 전수 동기화는 Search 의존 최소화,
  명시적 ID 트리 순회 권장. (근거: N §2.4/§9.3)
- **웹훅 페이로드 미포함 + 순서 미보장** → 시그널 수신 후 timestamp 재정렬 + API 재조회 패턴
  확정 필요(증분 동기화 트리거 설계). (근거: N §10.2/§10.4)
- 속성 수 ~100개 한도가 문서화되지 않아 스키마 진화(I4) 시 상한 검증을 합성 픽스처로 고정할 필요. **[가설]**
