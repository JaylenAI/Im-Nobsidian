# 경쟁 도구 분석

> 작성일: 2026-05-08
> 상태: complete

## 분석 대상

| #   | 도구                           | 방향              | 상태           | Stars |
| --- | ------------------------------ | ----------------- | -------------- | ----- |
| 1   | Nobsidion (quanphan2906)       | Obsidian → Notion | 방치 (2024-05) | 102   |
| 2   | Python Script (koshirok096)    | Obsidian → Notion | 학습 프로젝트  | -     |
| 3   | obsidian-to-notion (EasyChris) | Obsidian → Notion | 저활동         | 542   |
| 4   | Notion-to-Obsidian-Converter   | Notion → Obsidian | 성숙           | ~1000 |
| 5   | Share to NotionNext (jxpeng98) | Obsidian → Notion | 활발           | -     |

---

## 1. Nobsidion (quanphan2906)

### 개요

- GitHub: https://github.com/quanphan2906/nobsidion
- 라이선스: GPL-3.0
- 마지막 커밋: 2024-05 (1년+ 방치)
- 소스 파일: ~10개 TypeScript 파일

### 아키텍처

```
main.ts → service/index.ts (오케스트레이션) → service/notion.ts (API 호출)
                                            → @tryfabric/martian (변환)
```

### 핵심 구현

- `@tryfabric/martian`의 `markdownToBlocks()`에 전체 변환 위임
- 프론트매터에 `notionPageId` 저장 → 재업로드 시 기존 블록 삭제 후 재생성
- 위키링크: 정규식 추출 → 하이퍼링크로 변환 (Notion 멘션 아님)
- Notion API 직접 호출 (`requestUrl`, SDK 미사용)

### 심각한 문제점

1. **Rate limiting 없음** → 대량 업로드 시 API 오류
2. **100블록 제한 무시** → 큰 문서 무시됨
3. **페이지네이션 미처리** → 블록 삭제 불완전
4. **변경 감지 없음** → 매번 전체 재업로드
5. **역방향 없음** → 단방향만
6. **Notion측 편집 파괴** → 덮어쓰기
7. **콜아웃/이미지/임베드 미지원**
8. **console.log 남김**, 테스트 1개뿐

### 참고할 점

- `@tryfabric/martian` 활용 패턴 → 우리도 채택
- Obsidian Plugin 뼈대 구조 (main.ts, settingTab.ts)
- 위키링크 정규식: `/\[\[([^\]]+)\]\]/g`
- 프론트매터에 ID 저장하는 접근 → 우리는 SQLite DB로 대체 (더 견고)

---

## 2. Python Script (koshirok096, DEV Community 3부작)

### 개요

- 플랫폼: DEV Community 블로그 (학습 프로젝트)
- 방향: 단방향 (Obsidian → Notion), 수동 배치
- 시리즈: Part 1 (추가), Part 2 (태그 라우팅), Part 3 (Relation 연결)

### 핵심 구현

```python
# Part 1: 기존 페이지에 toggle 블록으로 추가
append_toggle_to_page(page_id, uid, body[:2000])

# Part 2: YAML 태그 기반으로 다른 DB에 페이지 생성
if "ToTask" in tags: create_page_in_db(TASKLIST_DB, uid, content)
if "ToFleeting" in tags: create_page_in_db(FLEETING_DB, uid, content)

# Part 3: Relation 속성으로 양방향 링크
relation_props = {DAILY_RELATION_PROP: {"relation": [{"id": daily_page_id}]}}
```

### 치명적 한계

- **마크다운 변환 없음** — raw 텍스트를 단일 paragraph에 2000자 잘라서 넣음
- **프론트매터 포함된 채로 전송** — YAML도 본문에 들어감
- 에러 재시도 없음, 중복 방지 없음, 파일명 YYYYMMDD 강제

### 참고할 점

- Notion API 인증 헤더 형식 확인
- Database query by title filter 패턴
- **Relation property JSON 구조**: `{"relation": [{"id": page_id}]}`
- 태그 기반 라우팅 (프론트매터 → 다른 DB 매핑) 컨셉
- 조건부 아카이브 (성공 확인 후에만 상태 변경)

---

## 4. 기타 주요 도구 (간략)

### obsidian-to-notion (EasyChris, ★542)

- 가장 많은 Star, Obsidian 플러그인
- 단방향 (Obsidian → Notion)
- 커스텀 배너, 모바일 지원, 태그 변환
- **한계**: 2단계 이상 중첩 불가 (Notion API 제약)

### Notion-to-Obsidian-Converter (connertennery, ★~1000)

- 가장 인기 있는 변환기
- Notion 내보내기 ZIP → Obsidian 볼트
- UUID 제거, 링크 변환, CSV DB 변환
- **한계**: 오프라인 변환만, API 미사용, 실시간 불가

### @tryfabric/martian (라이브러리)

- Markdown → Notion 블록 변환 라이브러리
- GFM alerts → Notion callouts 자동 변환
- 2000자 자동 분할, rich text 처리
- **우리 프로젝트의 핵심 의존성**

### notion-to-md (souvikinator)

- Notion 블록 → Markdown 변환 라이브러리
- v3: 플러그인 시스템, 커스텀 렌더러
- 페이지네이션 처리 (100블록/페이지)
- **우리 프로젝트의 핵심 의존성**

---

## 결론: 시장 갭

```
현재 시장 상황:

  단방향 (Obsidian→Notion):  포화 (EasyChris ★542, Nobsidion 등)
  단방향 (Notion→Obsidian):  성숙 (Converter ★~1000)
  양방향 (오픈소스):          빈자리 ← 여기가 우리 자리
```

**Im-Nobsidian이 채울 빈자리:**

- 양방향 + 오픈소스 + 무료 + 공식 API + 2026 최신 기능 활용
- 기존 어떤 도구도 이 조합을 제공하지 않음
