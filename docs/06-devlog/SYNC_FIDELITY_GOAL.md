---
type: project
title: "Notion ↔ Obsidian 100% 무손실 양방향 동기화 목표 스펙"
created: 2026-05-29
updated: 2026-05-29
status: active
tags: ["project/im-nobsidian", "type/spec", "sync/fidelity"]
related: ["[[CHANGELOG]]", "[[RELEASE_NOTES_v0.1.12]]"]
summary: "Claude Code /goal 로 자율 수행할 양방향 동기화 완벽화 미션·불변식·완료조건·방법론 단일 소스(SSOT)"
---

# Notion ↔ Obsidian 100% 무손실 양방향 동기화 — 목표 스펙

> 이 문서는 Claude Code `/goal` 의 **단일 진실 소스(SSOT)**다.
> `/goal` 에는 이 문서를 가리키는 짧은 한 줄만 넣고, 실제 미션·불변식·완료 조건·방법론은 모두 여기서 읽는다.
>
> **`/goal` 에 넣을 한 줄:**
>
> ```
> docs/06-devlog/SYNC_FIDELITY_GOAL.md 의 미션을 수행하라. 완료 조건: 이 문서의 "완료 조건" 절을 모두 충족(불변식 I1~I12 자동테스트 GREEN + 드리프트/멱등성/삭제 스크립트 clean + 회귀 0). 글로벌 CLAUDE.md와 이 문서의 보안·거짓종료방지 규칙을 준수하고, 종료 선언 전 실제 명령을 재실행한 출력 수치와 커버리지표를 사용자에게 확인받을 것.
> ```
>
> 시작 `/goal <위 한 줄>` · 진척 확인 `/goal` · 중지 `/goal clear`

---

## 미션

Im-Nobsidian(`/home/jaylenhan/AI_Personal/Obsidian_Notion_Syncer`, pnpm monorepo:
`core` / `cli` / `obsidian-plugin`)을 Notion ↔ Obsidian **100% 무손실 양방향 동기화**
수준으로 완성한다. 글로벌 `CLAUDE.md` 규칙(브랜치 전략·commit/push 사용자 허락·한국어·UV·
문서화 등)을 전부 준수한다.

---

## 완료 조건 — 아래가 **모두 참**이면 목표 종료

1. 불변식 **I1~I12** 를 검증하는 자동 테스트가 **골든 코퍼스 전체**에서 GREEN.
2. **드리프트 / 멱등성 / 삭제** 스크립트가 모두 clean(diff 0, churn 0, silent resurrection 0).
3. 전체 테스트 **회귀 0**(기준 777개 이상), `lint` / `typecheck` 클린.
   `it.skip` 수가 baseline(11)에서 **늘지 않고**, 불변식 관련 skip **0**.
4. **커버리지 이원화 완료**:
   - **도달 가능 타입**(API/플랜으로 생성 가능) = 실제 노트로 골든 코퍼스에 포함되어 검증됨.
   - **도달 불가 타입**(verification, cross-workspace synced_block, 일부 link_preview 등) =
     사유 명시 + **고정 JSON 합성 픽스처**로 변환 경로 검증. 이 분류는 **사용자 승인 1회로 잠금**.

> **종료 선언 전 반드시:** `pnpm typecheck && pnpm lint && pnpm test` + 드리프트/멱등성/삭제
> 스크립트를 **실제 실행**해 출력 수치로 확인하고, 커버리지표 + 결과를 사용자에게 제시해
> **확인받는다.** 기억·추정 종료 금지(거짓 종료 방지).

---

## 불변식 — "100% 완벽"의 정의

| ID      | 불변식                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **I1**  | MD 라운드트립: Obsidian MD → Notion → MD === 원본(정규화 후 **전체 문자열 deep-equal**, 추가/삭제 라인 0)                                                                                                          |
| **I2**  | Notion 라운드트립: Notion → Obsidian → Notion === 원본(속성/블록/순서/인라인 span 보존)                                                                                                                            |
| **I3**  | 무손실: 모든 블록·속성·**인라인** 타입을 MD로 매핑하거나, 불가 시 무손실 **preserve marker**로 보존·복원. 조용한 유실 금지. **손실 측정 = 입력/출력의 블록·속성·인라인span·첨부 개수 delta = 0**                   |
| **I4**  | DB 충실도: 모든 DB → 폴더 + `.base` + row별 frontmatter. 모든 뷰 표현 or **메타 보존 degrade**. 필터/정렬/그룹/컬럼 보존. **스키마 진화**(속성 추가/삭제/타입변경/rename)·**다중 data source** 마이그레이션 무손실 |
| **I5**  | 멱등성(**non-trivial fixpoint**): 1회차에 실제 변경 N>0 발생을 단언한 뒤 2회차 변경 0. diff churn 0                                                                                                                |
| **I6**  | 첨부: 모든 이미지/파일 다운로드·참조·재업로드 가능. **비교는 content_hash 기준(signed URL 만료·변동 무시)**. 외부 URL과 Notion 업로드 파일을 구분 보존, 중복 업로드 0                                              |
| **I7**  | Bases 렌더링: Obsidian에서 실제 정상 렌더 — 갤러리 커버/정렬/그룹/필터/컬럼. degrade 시 **잃는 뷰 설정을 frontmatter/preserve로 보존** + 미표현 항목 로그                                                          |
| **I8**  | 충돌: **base 스냅샷 기반 LCS 3-way 병합** or 명시적 마커. **false-conflict 0**(양측 동일 변경·무내용 last_edited_time 변경은 충돌 아님, 콘텐츠 해시 기준). 영구 충돌 루프 0. 조용한 덮어쓰기 금지                  |
| **I9**  | UIUX: 플러그인 뷰(table/gallery/list)가 동기화 데이터 충실 렌더, 설정/진행률/에러 일관 표시. 대용량 볼트 멈춤/누락 없음                                                                                            |
| **I10** | **삭제 전파**: 로컬 삭제→Notion archive 멱등(2회차 재삭제 0), Notion 휴지통→로컬 삭제(**silent resurrection 0** — `in_trash`가 search에 안 잡혀 재생성되는 부활 차단). `deleteSync` on/off 양쪽 동작 고정          |
| **I11** | **Notion API 구조 제약 무손실**: 요청당 100블록·2단계 중첩 한계를 넘는 구조(토글>column>list 등 깊은 중첩)를 깊이 평탄화/재귀 append로 무손실 push                                                                 |
| **I12** | **중단/크래시 복구**: push 부분 적용 후 재개 시 **중복 append(블록 2배) 0**, `pending_operations` 기반 재개 정확. 429 재시도가 같은 요청 2회 적용으로 이어지지 않음(idempotency 사전조회)                          |

### I3 — 라운드트립 커버 대상 (전수)

**블록:** paragraph, heading(1/2/3), bulleted/numbered/to_do list, toggle, quote, callout,
code, equation, divider, table, column_list/column, child_page, child_database, synced_block,
embed, bookmark, link_preview, image, video, file, pdf, audio, mention, breadcrumb,
table_of_contents.

**속성:** title, rich_text, number, select, multi_select, status, date(범위 포함), people,
files, checkbox, url, email, phone_number, relation, rollup, formula, created_time,
last_edited_time, created_by, last_edited_by, unique_id, verification.

**인라인(rich_text) 매트릭스 — 별도 명시 검증:** bold / italic / strikethrough / code /
underline / color / link / inline-equation / inline-mention 을 **한 문장 안에서 조합·겹침**으로
라운드트립. underline·color·inline-equation은 MD에 직접 표현이 없어 `color-annotator` /
`html-annotation` / preserve-marker 경로 회귀 테스트로 고정.

### I4 — DB 뷰 매핑

| Notion 뷰                                            | Bases | 비고                                                                                                                                |
| ---------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| table                                                | table |                                                                                                                                     |
| gallery                                              | cards | 커버 = files 속성을 **스칼라 URL/`[[wikilink]]`** 직렬화(Bases `image:` 는 스칼라만 렌더)                                           |
| list                                                 | list  |                                                                                                                                     |
| board                                                | cards | groupBy 보존                                                                                                                        |
| calendar / timeline / form / chart / map / dashboard | table | **메타 보존 degrade** — 잃는 date축·그룹핑·정렬을 frontmatter/preserve로 보존하고, 로그에 `원본뷰타입 + 의존속성 + 미표현항목` 기록 |

- 한 DB의 **다중 뷰**는 `.base` 의 다중 `view` 로 표현.
- `.base` 자신이 카드로 잡히지 않게 `filters` 에 `file.ext == "md"` 유지.
- 속성 id 비교 시 **양쪽 디코드 필수**: `views.retrieve`=RAW id(`[jiM`), `databases.retrieve`=URL-인코딩(`%5BjiM`).
- Bases 문법으로 못 옮기는 Notion 필터(rollup/relation 기반)는 **명시적 미지원 로그**.

---

## 방법론 — 반드시 이 순서/방식

1. **드리프트·멱등성·삭제 스크립트부터** 만든다.
   - 드리프트: `pull → 스냅샷 → push → pull → diff == empty`.
   - 멱등성: 1회차 변경 N>0 단언 → 2회차 변경 0(non-trivial fixpoint). + 1글자 수정→sync→재sync churn 0.
   - 삭제: 로컬/리모트 삭제·휴지통·archive 양방향 전파 + resurrection 0.
   - CI 편입 → 이후 모든 수정의 회귀 자동 감지.
2. **골든 코퍼스 = Im-Nobsidian-Test 볼트**(`/home/jaylenhan/Documents/Im-Nobsidian-Test`,
   현재 138 노트 / 449 첨부). 위 모든 타입을 **도달 가능/불가로 먼저 분류**(사용자 승인) 후,
   도달 가능 타입은 실제 노트로, 불가 타입은 합성 픽스처로 채운다. 수동 추가분은 목록으로 사용자에게 요청.
   **깊은 중첩 노트(토글>column>list)·100블록 초과 페이지를 강제 포함**.
3. **갭마다**: 실패하는 테스트 먼저(라운드트립/속성기반) → 최소 수정 → 라운드트립·멱등성 통과 → 전체 회귀 0.
4. 매 사이클 **불변식 커버리지표**(타입별 검증/미검증, 인라인 매트릭스 포함) 정량 갱신.
5. **적대적 자문**: "정말 무손실인가? 어떤 입력이 깨뜨리나?" — 엣지케이스를 코퍼스에 추가:
   빈 값 / 유니코드·이모지 / 매우 긴 텍스트 / 깊은 중첩 / 순환 relation / 만료 URL /
   동명 페이지 / 이름 충돌 / 특수문자·예약어 파일명 / 빈 DB / 컬럼 0개 뷰 / 인라인 서식 겹침.

### 공략 시작 순서

1. 드리프트+멱등성+삭제 스크립트 (**I5·I10** 안전망)
2. **I3 블록/속성/인라인 무손실** — relation · rollup · formula · date(범위) · synced_block · equation · column_list · 인라인 서식 매트릭스
3. **I11** 깊은 중첩 / 100블록 push 무손실
4. **I4 미지원 뷰** 메타 보존 degrade + 스키마 진화 마이그레이션
5. **rebuild 잔여 불변식 위반**(추정 ~60라인/34파일) 제거
6. **I8 충돌**(base 스냅샷 3-way, false-conflict 0) / **I12 크래시 복구**
7. **I9 UIUX**

---

## 거짓 종료(false GREEN) 방지 — 필수

- **부분문자열 단언 금지**: 라운드트립 완료 근거에서 `.toContain()` 금지. **정규화 후 전체 문자열 deep-equal + 개수 delta=0**만 인정.
- **normalize 화이트리스트 잠금**: 정규화 허용 항목은 공백/줄바꿈/리스트마커/속성키정렬/날짜포맷으로 **고정**. normalize 함수 변경은 **사용자 승인 필요**(silent drop을 정규화로 위장 차단).
- **회귀 잠금 테스트**(결정론적 픽스처): 방금 고친 4개 결함을 종료 조건에 박는다 —
  (1) RAW id `[jiM` vs URL-인코딩 `%5BjiM` 디코드 비교, (2) files 스칼라 URL 직렬화로 갤러리 커버 렌더,
  (3) `.base` 자기참조 `file.ext == "md"` 필터, (4) 인라인 페이지 멘션·embed/bookmark 보존마커 라운드트립.
- **실데이터 e2e 영구 skip 금지**: 토큰 있을 때 1회 이상 통과 증거(출력 인용)를 종료 전 요구. 핵심 회귀는 결정론적 픽스처로 보유.
- **skip baseline**: 시작 시점 11개 skip 사유 분류, 불변식 관련은 해제 또는 합성 픽스처 대체.

## 정체 감지

- 진척 지표에서 **'신규 추가 테스트 수' 제외**. **닫힌 불변식 수 / silent-drop 카운트 / churn 건수 / 미해결 갭 수**만 카운트(가짜 진척 회피).
- **2사이클 연속 무개선** 또는 **동일 파일/이슈 3사이클 연속 터치** 시 자동 종료 말고 정체 원인 + 선택지 2~3개를 사용자에게 보고.

---

## 보안 (필수 — `CLAUDE.md`에 없으므로 여기서 강제)

- Notion 토큰(`ntn_...`)은 **in-process 로만** 읽고 출력/echo **절대 금지**.
- CLI/probe 출력은 `/usr/bin/grep -v -i "ntn_\|token"` 로 필터(RTK-lenient grep 말고 절대경로 grep).
- signed image URL 프로빙 시 `secret` / `sig` / `token` / `X-Amz` / `Signature` 쿼리 **마스킹**.
- 페이지 ID는 비밀 아님.

---

## 진척 보고 형식

매 사이클: (1) 닫은 갭/불변식, (2) churn·silent-drop·미해결 갭 카운트 변화, (3) 회귀 여부,
(4) 커버리지표 갱신, (5) 남은 갭 Top-N. 완료 조건이 모두 참이고 사용자가 확인하면 종료 후
**릴리스 후보**(버전·CHANGELOG 초안) 제안.

---

## 참고 — 최근 해결된 결함(회귀 잠금 대상)

- 속성 id 인코딩 불일치(RAW vs URL-인코딩) → `title` 외 모든 속성 매칭 실패 → 디코드 비교로 해결.
- Bases `image:` 는 스칼라 문자열만 렌더 → files 속성을 스칼라 URL로 직렬화.
- `.base` 자신이 빈 카드 → `file.ext == "md"` 필터.
- `/p/<id>?pvs=` 인라인 멘션 → 위키링크 변환. embed/bookmark → 링크 + 보존 마커 라운드트립.

(상세: [[CHANGELOG]] `[0.1.12]`, [[RELEASE_NOTES_v0.1.12]])
