# ADR-003: 라운드트립 보존 시스템

> 상태: 승인
> 결정일: 2026-05-08

## 맥락

Obsidian과 Notion에는 서로 대응하지 않는 기능이 있다.
(예: Dataview는 Notion에 없고, Column Layout은 Obsidian에 없음)
이런 기능이 동기화 왕복(A→B→A) 과정에서 파괴되면 안 된다.

## 결정

**HTML 주석 기반 preserve marker** 시스템 도입.

## 형식

```html
<!-- im-nobsidian:preserve:{type}:{metadata} -->
{원본 콘텐츠}
<!-- /im-nobsidian:preserve -->
```

## 이유

1. **비침투적**: HTML 주석은 마크다운 렌더링에 영향 없음
2. **Notion에서 안전**: 코드 블록 내에 넣으면 보존됨
3. **파싱 용이**: 정규식으로 간단히 추출/복원
4. **확장 가능**: type 필드로 다양한 보존 대상 지원

## 대안 검토

- **별도 매핑 파일**: 복잡, 파일 추가 관리 필요
- **프론트매터에 저장**: 크기 제한, 복잡한 콘텐츠 부적합
- **무시 (동기화 제외)**: 사용자가 원본을 잃을 수 있음

## 결과

- `packages/core/src/converter/preserve.ts`에서 구현
- 라운드트립 테스트에서 보존 검증 필수
