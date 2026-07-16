# ADR-008: NFM 디자인 충실도 — 컬럼 구조·콜아웃 아이콘/색·블록 색 보존

> 상태: 승인
> 결정일: 2026-07-16

## 맥락

Notion Markdown Content API(NFM) raw 는 디자인 요소를 태그 속성으로 내보낸다
(2026-07-16 프로브 페이지 실측):

- 컬럼: `<columns>` + 탭 들여쓴 `<column>` 자식 (`width_ratio` 는 **API 자체가 드롭** — 보존 불가)
- 콜아웃: `<callout icon="⚠️" color="red_bg">` — 아이콘은 본문 이모지가 아니라 **속성**
- 색상 토글: `<details color="green_bg">`
- 블록 색: 줄 끝 `{color="red"}` (문단/제목/리스트/인용 공통)

기존 변환은 pull 때 이 정보를 전부 폐기했고(칼럼 평탄화, 속성 미캡처,
`cleanInlineColorAttrs` 가 `{color=}` 삭제), push 는 콜아웃 아이콘을 본문 첫 줄
이모지로 내보내 **Notion 에 리터럴 `📝` 텍스트가 오염**됐다(실측).
verbatim replace 는 모든 디자인 태그를 그대로 보존함을 실측 확인 — push 가
정준형을 재조립하면 무손실이 가능하다.

## 결정

**압축형 보존 마커로 디자인 속성을 왕복시킨다** (ADR-003 확장, 마커 SSOT 재사용).

| 요소    | pull (Obsidian 표현)                                                                                                                              | push (재조립)                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 컬럼    | 기존 block 경로와 동일 어휘: `%%im-nobsidian:column-list:start%%` / `%%im-nobsidian:column%%` / `%%im-nobsidian:column-list:end%%` 로 감싼 평탄화 | 마커 영역 → `<columns><column>…` 재조립                     |
| 콜아웃  | `> [!type] 제목 %%im-nobsidian:callout-style:icon=<enc>&color=<enc>%%` (icon 이모지→type 매핑)                                                    | 마커 → `<callout icon color>`, 마커 없으면 type→`icon` 속성 |
| 토글 색 | `> [!toggle]- 제목 %%im-nobsidian:toggle-color:<색>%%`                                                                                            | `<details color="<색>">`                                    |
| 블록 색 | 줄 끝 `%%im-nobsidian:block-color:<색>%%`                                                                                                         | 줄 끝 `{color="<색>"}`                                      |

- 콜아웃 push 는 `::: callout` 펜스 + 본문 이모지 대신 **정준형 태그 + 속성**을 낸다
  (마커 없는 사용자 작성 콜아웃도 type→emoji 를 `icon` 속성으로 — 본문 오염 제거).
- 컨테이너 안에 중첩된 컬럼(토글/콜아웃 내부)은 마커가 quote prefix 를 얻어 재조립
  불가 → pull 때 해당 마커 줄을 제거해 **기존 평탄화로 degrade** (Notion 으로 마커
  리터럴 누수 금지가 우선).
- push 마지막에 소비되지 않은 디자인 마커를 일괄 제거하는 안전망을 둔다.

## 이유

1. **실측 정합**: verbatim replace 무손실이 실측됐으므로 정준형 재조립 = 무손실.
2. **볼트 호환**: 컬럼 마커는 legacy block 경로(block-converter)와 동일 어휘 —
   두 경로 산출물이 구분 불가.
3. **비침투적**: `%%…%%` 는 Obsidian 프리뷰에서 숨는 주석(기존 compact 마커 관례).

## 트레이드오프

- `width_ratio` 는 NFM 이 create/replace 에서 자체 드롭 — 보존 포기(문서화).
- 컨테이너-중첩 컬럼은 구조 보존 포기(평탄화 유지) — Notion UI 에서 드문 구성.
- 마커가 본문에 노출되는 소스 뷰에서는 시각 노이즈(기존 마커와 동일한 수용 비용).

## 영향

- `enhanced-md-converter.ts` pull/push 파이프라인, `markers.ts` (마커 추가)
- 라운드트립 테스트 + 실 Notion 프로브 검증 필수 (M-D→N-D→M-D 수렴)

## 검증 (2026-07-16 실측)

실 Notion 프로브(`__p4_verify__`)에서 정준형 생성 → pull → push replace → re-pull:

- 디자인 프로브 토큰 21종 전부 보존 — 컬럼 구조·콜아웃-in-칼럼·아이콘 5종·
  블록 배경색 4종·블록 색 4형태·span 2종·코드-in-콜아웃·중첩 콜아웃·빈 제목 토글
- 마커 리터럴 Notion 누수 0건
- 2차 왕복 **바이트 수준 수렴** (`raw2 === raw3`, `pulled === pulled2`)
- 기본 아이콘(type 기본 이모지)+무색 콜아웃은 마커 생략 — push 가 type 에서 재생성
  하므로 무손실이며 볼트 노이즈가 없다
