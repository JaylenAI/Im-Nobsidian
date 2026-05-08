# 제품 요구사항 정의서 (PRD)

> 작성일: 2026-05-08
> 상태: draft
> Phase 1에서 작성 예정

## 기능 요구사항 (MoSCoW 우선순위)

### Must Have (v1.0 필수)
- [ ] MD → Notion 블록 변환 (A등급 기능 전체)
- [ ] Notion 블록 → MD 변환 (A등급 기능 전체)
- [ ] 라운드트립 안전성 보장
- [ ] SHA-256 기반 변경 감지
- [ ] 양방향 수동 동기화 (push / pull / sync)
- [ ] 폴더 ↔ 페이지 계층 매핑
- [ ] 충돌 감지 + conflict copy 생성
- [ ] CLI (init, sync, push, pull, status)
- [ ] Obsidian 플러그인 (커맨드 팔레트 + 설정)

### Should Have (v1.0 목표)
- [ ] [[위키링크]] ↔ Notion 페이지 멘션 변환
- [ ] 콜아웃 ↔ Callout 블록 변환
- [ ] 프론트매터 ↔ Notion 속성 변환
- [ ] 이미지 업로드/다운로드
- [ ] 자동 동기화 (파일 감시)
- [ ] Notion 웹훅 기반 변경 감지

### Could Have (v1.x)
- [ ] Notion DB → 폴더 + 프론트매터 파일
- [ ] Relations → [[위키링크]]
- [ ] 벌크 연산 최적화
- [ ] 동기화 필터 (폴더/태그 기반)

### Won't Have (v1 범위 외)
- 모바일 앱
- Dataview 동기화
- 실시간 협업
- Notion 댓글 동기화

## 비기능 요구사항

| 항목 | 기준 |
|------|------|
| 성능 | 100개 노트 동기화 5분 이내 |
| 안정성 | 데이터 손실 0건 |
| 호환성 | Node.js 20+, macOS/Linux/Windows |
| 테스트 | 커버리지 80%+ |
| 문서 | 한국어 + 영어 README |
