# Notion API 무손실 동기화 설계 (전·후처리 전략)

> 목적: Notion ↔ Obsidian **100% 무손실 양방향 동기화**를 위해 Notion API 의 구조적
> 한계를 전수 조사하고, 각 한계에 대한 전처리(pre)·후처리(post)·보존마커·사이드카 전략을
> 한 문서에 종합한다. 4종 1차자료 리서치(구조/쿼터·블록·인라인·DB/뷰/파일)의 결론을 통합한
> **권위 있는 설계 레퍼런스**다.
>
> 연관: [[SYNC_ENGINE_DESIGN]] · [[CONVERSION_PIPELINE]] · [[DATA_MODEL]] ·
> `docs/06-devlog/SYNC_FIDELITY_GOAL.md`(불변식 I1~I12)

---

## 0. 핵심 아키텍처 결정 (요약)

1. **Markdown Content API 를 1차 채널로 사용한다.** Notion 의 "Enhanced Markdown"(2026-02-26 GA)은
   CommonMark 가 아니라 XML 확장 마크다운으로, underline·color·bg-color·inline equation·5종 mention·
   callout·columns·toggle·table·synced_block·page/db 참조를 **네이티브로 표현**한다. martian /
   notion-to-md 는 이들을 누락하므로 서드파티 변환 대신 네이티브 마크다운 API 를 우선한다.
2. **Markdown API 의 사각지대는 Blocks API 정합 패스로 메운다(dual-pass).** bookmark·embed·
   breadcrumb·link_preview·template 는 `retrieveMarkdown()` 출력에 **렌더되지 않는다**. 이들은
   `blocks.children.list()` 병행 패스로 탐지해 보존마커로 봉합하고, 역방향에서 Blocks API 로 복원한다.
3. **표현 불가 메타데이터는 사이드카(`<db>.notion.json`)로 보존한다.** 뷰 레이아웃·status groups·
   select option id/color·rollup/formula 정의·dual-relation synced name·멀티 데이터소스 매핑 등.
4. **단일 보존마커 문법으로 통일한다.** 비가시 HTML 주석 `<!--ntn:KEY=VALUE-->` / `<!--obs:KEY=VALUE-->`.
   Obsidian 미리보기에서 안 보이고, 편집기에서 살아남으며, Notion 마크다운 파서가 무시한다.
5. **파괴적 쓰기 금지.** `update_content`(타겟 검색-치환) 기본, `replace_content`는 신규/전체재작성 명시
   옵트인에만. `allow_deleting_content`는 기본 false 유지.
6. **비가역 손실은 정직하게 리포트한다.** API 로 복원 불가한 항목(아래 §6)은 침묵 폐기하지 않고 사용자에게 보고.

---

## 1. 구조·쿼터 하드리밋 (요청 단위)

| 제약             | 값                                    | 비고                                             | 대응                                                                              |
| ---------------- | ------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| children/append  | 100                                   | 초과 시 거부                                     | 배치 분할(이미 batchSize=100)                                                     |
| 중첩 깊이/요청   | 2단계                                 | 더 깊으면 거부/드롭                              | **재귀 deep-append**(2단계 전송 → resp.results[].id 포착 → 3단계+ 재귀)           |
| payload 블록 수  | 1000                                  |                                                  | 청크                                                                              |
| **본문 바이트**  | **500KB → 413**                       | **비재시도 하드 실패**                           | **column-0 블록 경계로 청크 분할**(markdown API 도 적용)                          |
| rich_text run    | 2000자                                | 초과 시 검증오류                                 | 다중 세그먼트로 분할(블록 1개 유지)                                               |
| equation         | 1000자                                |                                                  |                                                                                   |
| 페이지 블록 총량 | ~20,000                               | retrieve 시 `truncated:true`+`unknown_block_ids` | **retrieve 시 truncated/unknown_block_ids 검사** — 미검사 시 거대페이지 무음 손실 |
| 페이지네이션     | 100/page                              |                                                  | start_cursor 루프(구현됨)                                                         |
| rate limit       | ~3 req/s                              | 429 시 `Retry-After` 준수                        | async-sema 3 req/s(구현됨)                                                        |
| 재시도 가능      | 409/502/503/504                       |                                                  |                                                                                   |
| 재시도 불가      | 400/413/401/403/404                   |                                                  |                                                                                   |
| 파일 업로드      | >20MB 멀티파트, 5GB 최대, 5~20MB 파트 |                                                  | File Upload API                                                                   |

> **중요(검증됨):** 기본 push 경로(`preferMarkdownApi=true`)는 100블록·2단계중첩 제한을 **서버측에서
> 우회**한다(탭 들여쓰기로 무제한 깊이). 따라서 I11 의 깊은 중첩/대량 블록은 기본 경로에선 대부분
> 자동 처리되며, `deep-nesting.invariant.test.ts` 가 이를 실측으로 못박는다. **남는 진짜 위험은
> 500KB/413 청킹과 truncated/unknown_block_ids 처리**(거대 페이지)와 **블록 폴백 경로의 재귀 deep-append**다.

---

## 2. 블록 레벨 한계 매트릭스 (요약)

무손실: paragraph, heading_1~4, toggle(블록/헤딩), callout, quote, code, to_do, list,
divider, table, equation(블록/인라인), column_list/column, table_of_contents,
synced_block(생성만), page/database 참조 — **모두 Enhanced Markdown 태그로 왕복**.

### 하드 갭

**A. Blocks API 로 생성 가능하나 Markdown API 가 렌더 안 함** → `retrieveMarkdown()`에서 **무음 소실**:
`bookmark`, `embed`, `breadcrumb`, `link_preview`, `template`.

- **대응**: 후처리에서 `blocks.children.list()` 병행 → 해당 블록 위치에
  `<!--ntn:bookmark id="..." url="..." caption="..."-->` 보존마커 삽입. 전처리에서 마커 파싱 →
  Markdown API 본문 작성 후 **2차 Blocks-API append**(`after_block` 위치 지정)로 복원.

**B. 어떤 엔드포인트로도 생성 불가(read-only)**:
`link_preview`(unfurl 통합 전용), `template`(2023-03-27 생성 제거), `button`/`form`(→ `<unknown alt>`),
`meeting_notes`(AI 블록), `child_page`/`child_database`(블록 아닌 page/database 엔드포인트로 처리).

- **대응**: `<unknown url alt/>` 태그를 **그대로 보존**(이미 보존마커 역할). `replace_content` 금지,
  `update_content` 사용. child_page/child_database 는 `<page url>`/`<database url>` 참조만 내보내고 본문은 재귀 동기화.

**C. 생성 가능하나 갱신 제약**:

- `synced_block` 본문 **갱신 불가** → 편집 시 skip-and-warn(무음 손실 금지).
- table `table_width` **불변** → 컬럼 수 변하면 delete+recreate.
- Notion-hosted 파일 URL **1시간 만료** → 재호스팅(§5).

---

## 3. 인라인/리치텍스트 한계 + 무손실 변환

**정정(통념 오류):** Notion 자체 마크다운은 underline/color 에 대해 **무손실**이다
(`<span underline="true">`, `<span color="Color">`, bg 는 `*_bg`). 진짜 문제는 **Obsidian**이
이 표기를 관용적으로 다루지 않는다는 점(Obsidian 은 `<u>`, `==highlight==` 사용, color 개념 없음).

| Obsidian 관용 | Notion Enhanced-MD                 | 보존마커                              |
| ------------- | ---------------------------------- | ------------------------------------- |
| `<u>x</u>`    | `<span underline="true">x</span>`  | 불필요(완전 가역)                     |
| `==x==`       | `<span color="yellow_bg">x</span>` | yellow_bg 아니면 `<!--ntn:c=COLOR-->` |
| (color 없음)  | `<span color="COLOR">x</span>`     | `<!--ntn:c=COLOR-->...<!--/ntn:c-->`  |
| `[[Note]]`    | `<mention-page url>`               | `<!--ntn:page=ID-->`                  |
| `![[embed]]`  | mention-page / `![](signedurl)`    | `<!--ntn:embed kind=...-->`           |
| 날짜 텍스트   | `<mention-date .../>`              | `<!--ntn:date ...-->`                 |
| `[^1]` 각주   | 인라인/Footnotes 토글              | `<!--obs:fn id=1-->`                  |
| `#tag`        | 페이지 multi-select 속성           | `<!--obs:tag-->`                      |
| `# H`(+color) | `# H {color="C"}`                  | `<!--ntn:hcolor=C-->`                 |

- **underline**: `<u>` ↔ `<span underline="true">` 완전 가역. **[I3 핵심 — 현재 push 시 strip 됨, 수정 대상]**
- **color/bg**: `==text==` → `yellow_bg` 결정적 매핑 + 나머지 17색은 `<!--ntn:c=-->` 마커.
- **overlapping annotation**: Notion rich*text 는 annotation 집합이 독립 → `<span color>\*\*\_text***</span>` 처럼 중첩.
  역방향에선 동일 annotation 연속 span 을 **병합(coalesce)\*\* 해 diff churn 최소화.
- **mention**: 읽기는 무손실(url+href+UUID), **생성은 대상 UUID 필요** → `idmap`(경로↔page_id) 유지 필수.
  user/agent mention 은 UUID 마커 없이는 평문 강등.

---

## 4. DB/속성/뷰 한계 (API 2025-09-03 멀티 데이터소스)

### 4.1 멀티 데이터소스

- `database`(컨테이너) → `data_sources[]` → pages. 스키마는 **data source 에 존재**.
- `GET /v1/databases/:id` 는 `data_sources[]`(id+name)만 반환 → 발견 단계 필수.
- query/update/page-create/relation 전부 `data_source_id` 기준.
- **현재 코드 갭**: client 가 `data_sources[0]`만 사용 → 멀티소스 DB 의 2번째+ 소스 소실.
- **대응**: data source 당 폴더 1 + `.base` 1, 컨테이너 관계는 사이드카에 `database_id↔data_sources[]` 기록.

### 4.2 read-only 속성 (값 쓰기 불가)

`formula`, `rollup`, `created_time`, `last_edited_time`, `created_by`, `last_edited_by`,
`unique_id`, `place`, `button`, `verification.verified_by`.

- **스키마 정의(formula `expression`, rollup config, unique_id `prefix`)는 쓰기 가능** → 정의는 왕복.
- **식별/감사 값(unique_id `PREFIX-123`, created_time)은 Notion 재생성 시 리셋** → frontmatter 로 **미러링**
  (`_notion_uid`, `_notion_created`)해 인간 의미값 보존. **[I7 — 수정 대상]**
- `place` 는 read 시 **`null` 반환 → 비가역 손실**. `button` 은 page-property-values 에 부재 → 마커만.

### 4.3 relation 25개 cap

page-retrieve 는 relation 을 **25개로 무음 절단**(`has_more`). **Retrieve page property item**(100/page)으로
재조회해야 완전. 순서 미보장. **현재 코드 미처리 → 수정 대상.**

### 4.4 뷰 (API 노출 제로)

- database object 스키마에 **뷰 정의 전무**(board/calendar/gallery/timeline 설정·필터·정렬·그룹·숨김컬럼 모두 불가).
  ※단, 현 코드는 Notion **Views API**(`views.list`/`views.retrieve`)로 일부 뷰 메타(이름·타입·sort·cover)를
  읽고 있음 — 이름 없는 뷰는 'Untitled' 다수 반환(dedupe 로 해결됨).
- `.base` 를 **뷰 권위원(authoritative)** 으로 삼는다: table→table, gallery→cards, list→list.
- **board/calendar/timeline → Bases 무등가** → cards+groupBy / 정렬 table 로 degrade + 뷰 degrade 마커.
- map/place → `place` read `null` 이므로 degrade.

---

## 5. 파일/만료 URL 무손실 재호스팅

- `type:file`(Notion-hosted): `url`은 **1시간 만료 S3 서명링크** — 캐시 금지, 만료 시 재조회.
- `type:external`: 영구 — 그대로 보존.
- **pull**: `expiry_time` 검사 → 만료 임박/경과 시 페이지 재조회로 새 URL 발급 → **즉시 다운로드** → 볼트
  attachments 저장. `{notion_kind, original_name, external_url?}` 기록.
- **push**: 로컬 파일 `POST /v1/file_uploads`(>20MB 멀티파트), 원격은 `mode:"external_url"`,
  **1시간 내 attach**, 5MB/5GB 캡·900byte 파일명 준수. **블록 *갱신*은 file_upload 불가 → external URL 필요.**
- caption: 미디어 블록 `caption[]` rich_text 왕복. icon/cover: emoji→frontmatter, external/uploaded→재호스팅.

---

## 6. 비가역 손실 (현 API 로 무손실 불가 — 정직 리포트 대상)

1. 인라인 코멘트 앵커(텍스트 범위)·resolved 코멘트
2. link_preview **네이티브 unfurl** 재생성
3. 새 인라인 토론 시작
4. 저장된 **뷰 정의/레이아웃**(board/calendar/timeline 필터·정렬·그룹)
5. `button` 속성/블록
6. `place`(지오) 값 — read `null`
7. status **group** 재구성(기본 그룹만 생성 가능)
8. 불변 감사/식별 필드의 **원본값**(created_time/by, unique_id) — frontmatter 미러로 인간값은 보존

→ 사이드카 + 마커로 **forward-compatible** 하게 포착(Notion 이 향후 API 개방 시 복원 가능)하고,
sync 당 "lossy 필드" 요약을 사용자에게 표시한다.

---

## 7. 보존마커 문법 (단일 SSOT)

```
<!--ntn:KEY=VALUE ...-->        Notion 기원 메타데이터(색/멘션/블록 id 등)
<!--obs:KEY=VALUE-->            Obsidian 기원 메타데이터(각주/태그 등)
<!--/ntn:KEY-->                 범위 종료(span 류)
<unknown url="..." alt="..."/>  Notion 이 직접 주는 미렌더 블록 포인터 — 그대로 보존
```

- HTML 주석: Obsidian 미리보기 비가시 + 편집기 생존 + Notion 마크다운 무시.
- 전처리는 `ntn:` 마커를 실제 태그로 환원한 뒤 중복 제거.
- 미지 블록 타입 탐지는 `unsupported.block_type` / `<unknown alt>` 기반 **데이터 주도**로 graceful degrade.

---

## 8. 구현 로드맵 (불변식·태스크 매핑)

| 우선 | 항목                                                    | 불변식 | 상태                              |
| ---- | ------------------------------------------------------- | ------ | --------------------------------- |
| P0   | `.base` 뷰 이름 dedupe                                  | I4     | ✅ 완료(feature/db-base-fidelity) |
| P0   | E2E 하니스 정확도(better-sqlite3·오판)                  | —      | ✅ 완료                           |
| P1   | I3 underline/color 무손실 push                          | I3     | ⏳ #47                            |
| P1   | 사이드카 `.notion.json`(뷰/status/option/멀티소스/마커) | I4·I7  | ⏳ #45                            |
| P1   | read-only 식별 필드 미러링(unique_id/created_time)      | I7     | ⏳ #46                            |
| P2   | dual-pass: bookmark/embed/breadcrumb 봉합               | I2·I3  | 신규                              |
| P2   | relation 25-cap 페이지네이션                            | I4     | 신규                              |
| P2   | 500KB/413 청킹 + truncated/unknown_block_ids 처리       | I11    | 신규                              |
| P3   | 블록 폴백 재귀 deep-append                              | I11    | 신규                              |
| P3   | 멀티 데이터소스 전체 지원                               | I4     | 신규                              |

---

## 9. 1차 출처

- Enhanced Markdown: https://developers.notion.com/guides/data-apis/enhanced-markdown
- Working with markdown content(+`<unknown>`/unknown_block_ids): https://developers.notion.com/guides/data-apis/working-with-markdown-content
- Rich text object/annotations: https://developers.notion.com/reference/rich-text
- Block reference: https://developers.notion.com/reference/block
- Append block children(100/2단계): https://developers.notion.com/reference/patch-block-children
- Property object / Page property values: https://developers.notion.com/reference/property-object
- Data source / Database object: https://developers.notion.com/reference/data-source · https://developers.notion.com/reference/database
- Upgrade guide/FAQ 2025-09-03: https://developers.notion.com/docs/upgrade-guide-2025-09-03
- File object / Working with files: https://developers.notion.com/reference/file-object · https://developers.notion.com/guides/data-apis/working-with-files-and-media
- Comments: https://developers.notion.com/guides/data-apis/working-with-comments
- Obsidian Bases: https://obsidian.md/help/bases/syntax · https://obsidian.md/help/bases/views
