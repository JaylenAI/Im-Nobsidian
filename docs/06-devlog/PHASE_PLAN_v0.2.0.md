# Im-Nobsidian v0.2.0 완전 개선 계획

> 작성일: 2026-05-13
> 목표: Notion API 한계 외 **모든 콘텐츠 양방향 완벽 보존**

## 발견된 이슈 요약

- CRITICAL 8개 (데이터 유실)
- MODERATE 20개 (기능 미완성/변형)
- MINOR 8개 (엣지 케이스)

### 핵심 기술 전환

| 항목            | Before (v0.1.x)                  | After (v0.2.0)                                               |
| --------------- | -------------------------------- | ------------------------------------------------------------ |
| Pull 변환       | notion-to-md v3 (Issue #98 버그) | **Notion Markdown API** (GET /v1/pages/:id/markdown)         |
| Push 변환       | martian + blocks API             | **Markdown API** (POST/PATCH markdown) + blocks API fallback |
| 이미지 Push     | 플레이스홀더 텍스트              | **File Upload API** (직접 업로드)                            |
| 위키링크        | 볼드 텍스트 변환 (파괴적)        | **페이지 멘션** (양방향 매핑)                                |
| 프론트매터 저장 | 마크다운 테이블 (파싱 오류)      | **YAML 코드블록** (무손실)                                   |
| Notion SDK      | @notionhq/client 2.3.0           | **@notionhq/client 5.21.0**                                  |
| API 버전        | 2022-06-28                       | **2026-03-11**                                               |

---

## Phase 1: Notion Markdown API 전환 [3-4일]

**Branch**: `feature/markdown-api-migration`
**상태**: [x] 완료 (2026-05-13)

### 목표

notion-to-md v3 의존 제거. Notion 공식 Markdown API로 Pull/Push 핵심 경로 전환.
토글/child_page/콜아웃 콘텐츠 누락 문제 근본 해결.

### 작업 목록

- [ ] @notionhq/client 2.3.0 → 5.21.0 업그레이드
- [ ] Notion-Version 헤더 2026-03-11로 변경
- [ ] client.ts: getPageMarkdown() 메서드 추가
- [ ] client.ts: createPageWithMarkdown() 메서드 추가
- [ ] client.ts: updatePageMarkdown() 메서드 추가
- [ ] enhanced-md-converter.ts 신규 생성
  - Notion enhanced MD → 옵시디언 MD 변환
  - `<details>/<summary>` → 토글 마커
  - `<mention-page>` → [[위키링크]]
  - `::: callout` → > [!type] 콜아웃
- [ ] orchestrator.ts: pullCreate/pullUpdate에서 Markdown API 사용
- [ ] orchestrator.ts: pushCreate/pushUpdate에서 Markdown API 사용
- [ ] blocks API를 fallback으로 유지 (Markdown API 실패 시)
- [ ] 기존 notion-to-md 커스텀 트랜스포머 코드 보존 (fallback용)

### 검증

- [ ] Sources 21파일 Push→Pull 라운드트립 diff 0
- [ ] 토글 포함 페이지 Pull 시 내부 콘텐츠 완벽 보존
- [ ] child_page 링크 [[제목]] 형태로 Pull
- [ ] pnpm typecheck && pnpm build 클린

---

## Phase 2: 위키링크 ↔ 페이지 멘션 매핑 [2-3일]

**Branch**: `feature/wikilink-mention-mapping`
**상태**: [x] 완료 (2026-05-13)
**의존**: Phase 1

### 목표

[[위키링크]]를 Notion 페이지 멘션으로 변환하여 양방향 완벽 보존.

### 작업 목록

- [x] state-db.ts: resolveWikilink() 메서드 활용 (title/alias/filename 조회)
- [x] wikilink.ts(전처리기): 볼드 변환 → 페이지 멘션 변환으로 교체
  - StateDB에서 대상 페이지 ID 조회 (WikilinkResolverFn 주입)
  - 찾으면 → `<mention-page id="pageId">` 태그 생성
  - 못 찾으면 → `im-nobsidian://wikilink/` 보존 링크 + preserve marker
  - `![[embed]]` 패턴 무시 (negative lookbehind)
- [x] mention-to-wikilink.ts(후처리기): 3가지 패턴 복원
  - notion.so URL 패턴 확장 (www 없는 경우 포함)
  - `im-nobsidian://wikilink/` 보존 링크 → `[[target|display]]` 복원
  - `im-nobsidian://embed/` 보존 링크 → `![[target]]` 복원
- [x] orchestrator.ts: enhanced-md-converter 통합
  - Pull: `notionEnhancedToObsidian()` 적용 (mention-page → [[wikilink]])
  - Push: `obsidianToNotionEnhanced()` 적용 (callout/toggle → 노션 형식)
  - pushCreate/pushUpdate에서 aliases 추출 및 wikilink_map 업데이트
- [x] pipeline-factory.ts: WikilinkResolverFn 주입 구조 추가
- [x] frontmatter.ts: YAML 내 위키링크 제거 로직 삭제 (보존)
- [x] embed.ts: 노트 임베드 ![[note]] → `im-nobsidian://embed/` 보존 처리
- [x] callout.ts: markdown-api 경로에서 CalloutTransformer 스킵

### 검증

- [x] [[My Note]] Push → Notion 페이지 멘션 표시 → Pull → [[My Note]] 복원
- [x] 존재하지 않는 [[미래노트]] → 보존 링크 → Pull 시 [[미래노트]] 복원
- [x] 프론트매터 내 [[위키링크]] 왕복 보존
- [x] ![[노트임베드]] 왕복 보존
- [x] 364개 테스트 통과, typecheck 클린, build 성공

---

## Phase 3: 이미지 직접 업로드 [1-2일]

**Branch**: `feature/image-upload`
**상태**: [x] 완료 (2026-05-13)
**의존**: Phase 1

### 목표

File Upload API로 로컬 이미지를 Notion에 실제 업로드. 플레이스홀더 + 실제 이미지 블록 병행.

### 작업 목록

- [x] client.ts: uploadFile(filePath) 메서드 (Phase 1에서 구현)
  - fileUploads.create() → send() → complete() → file_upload ID
- [x] vault-fs.ts: VaultFS 인터페이스에 readBinary() 추가
- [x] node-vault-fs.ts: readBinary() 구현
- [x] image-handler.ts: NotionClient 의존성 주입 (optional)
- [x] image-handler.ts: uploadLocalImage() — 로컬 이미지 읽기 → 업로드
- [x] image-handler.ts: uploadAndAppendImages() — 이미지 업로드 후 블록 추가
- [x] image-handler.ts: readImageFromVault() — 경로 fallback (직접 → attachments/)
- [x] orchestrator.ts: ImageHandler에 NotionClient 전달
- [x] orchestrator.ts: pushCreate/pushUpdate 후 이미지 업로드 호출
- [x] embed.ts: 플레이스홀더 텍스트 간결화 (verbose 메시지 제거)
- [x] 업로드 실패 시 기존 플레이스홀더 유지 (graceful degradation)
- [x] Pull 시 Notion 이미지 → 로컬 다운로드 (기존 로직 유지)

### 검증

- [x] 391개 테스트 통과, typecheck 클린, build 성공
- [x] 이미지 업로드 단위 테스트 8개 추가 (upload, fallback, graceful degradation)
- [x] 라운드트립 테스트: 이미지 메타데이터 수집 검증 (로컬/외부 이미지 분류)
- [x] Mock VaultFS에 readBinary 반영 (orchestrator, image-handler, conflict 테스트)

---

## Phase 4: 동기화 엔진 버그 수정 [2-3일]

**Branch**: `feature/sync-engine-fixes`
**상태**: [x] 완료 (2026-05-13)
**의존**: Phase 1

### 목표

데이터 무결성 보장. 거짓 변경 감지, 파일 이동, 크래시 복구 등 버그 수정.

### 작업 목록

- [x] orchestrator.ts: pushUpdate 후 notionLastEdited 저장 (이미 구현됨)
- [x] orchestrator.ts: push()/pull() 시작 시 in_progress 플래그 확인 → cleanupInterruptedSync()
- [x] orchestrator.ts: pullCreate 중복 파일명 처리 — resolveUniqueFilePath() (1)~(99) 접미사
- [x] orchestrator.ts: force 옵션 구현 (충돌 파일도 push 허용)
- [x] orchestrator.ts: conflictStrategy 구현 (local-first: 로컬 유지, remote-first: 리모트 덮어쓰기, manual: 충돌 표시)
- [x] orchestrator.ts: sync.direction 설정 반영 (push-only/pull-only 차단)
- [x] orchestrator.ts: deleteSync=false 시 pending 상태로 전환 (삭제 안 함)
- [x] orchestrator.ts: pushUpdate 블록 삭제 병렬화 (세마포어)
- [x] orchestrator.ts: dryRun 시 실제 변경 예정 수량 반환
- [x] change-detector.ts: mtime 최적화 (이미 구현됨 — mtime 비교)
- [x] change-detector.ts: 이동 감지 (이미 구현됨 — detectMoves())
- [x] client.ts: 502/503/504 재시도 (이미 구현됨 — isRetryable())
- [x] client.ts: extractTitle 전체 rich_text 결합 (이미 구현됨 — .join(""))

### 검증

- [x] 396개 테스트 통과 (5개 신규), typecheck 클린, build 성공
- [x] sync.direction 테스트: pull-only 시 push 차단, push-only 시 pull 차단
- [x] force 옵션 테스트: 충돌 파일도 push 허용
- [x] dryRun 테스트: 실제 예정 수량 반환 (0이 아닌 실제 값)
- [x] in_progress 클린업 테스트: 시작 시 이전 중단 플래그 정리

---

## Phase 5: 프론트매터/프로퍼티 왕복 보존 [2일]

**Branch**: `feature/frontmatter-roundtrip`
**상태**: [x] 완료 (2026-05-13)
**의존**: Phase 2 (위키링크 보존)

### 목표

프론트매터 모든 값(특수문자, 위키링크, 배열) 완벽 왕복.

### 작업 목록

- [x] properties-table.ts: 마크다운 테이블 → YAML 코드블록으로 전환
  - `\`\`\`yaml\n# im-nobsidian:properties\n...\n\`\`\``
  - gray-matter.stringify()로 안전한 YAML 직렬화
- [x] properties-table-restorer.ts: YAML 코드블록 파싱 + 레거시 테이블 호환
  - gray-matter로 정확한 YAML 파싱
  - 기존 마크다운 테이블 형식도 계속 지원 (하위 호환)
- [x] frontmatter.ts: 위키링크 제거 로직 삭제 (Phase 2에서 완료)
- [x] callout.ts: 모든 콜아웃에 원본 타입 preserve marker 추가 (접기/비접기 모두)
- [x] callout-restorer.ts: preserve marker에서 원본 타입 복원 (foldable 선택적)

### 검증

- [x] 398개 테스트 통과, typecheck 클린, build 성공
- [x] `value: "hello, world"` 왕복 보존 (YAML 코드블록으로 배열 변환 없음)
- [x] `data: "col|row"` 왕복 보존 (파이프 안전 — YAML에서 문자열)
- [x] 배열 값 YAML 리스트 형태로 정확한 왕복
- [x] 레거시 마크다운 테이블 형식 하위 호환 테스트 통과
- [x] 콜아웃 원본 타입 preserve marker 추가 (summary→summary 유지)

---

## Phase 6: 테스트 + 문서 + v0.2.0 릴리스 [2일]

**Branch**: `feature/tests-and-release`
**상태**: [x] 완료 (2026-05-13)
**의존**: Phase 1-5 전부

### 작업 목록

- [x] 라운드트립 테스트 20개 (토글, 위키링크, 이미지, 프론트매터, 중첩구조)
- [ ] Sources 폴더 실제 E2E (Notion API 토큰 필요)
- [ ] 마음AI 페이지 실제 E2E (Notion API 토큰 필요)
- [x] CHANGELOG: v0.2.0 항목
- [x] 알려진 한계 문서화 (인라인 DB, 버튼/폼, 실시간 동시 편집)
- [x] CURRENT_STATUS.md 업데이트
- [x] pnpm lint && pnpm typecheck && pnpm build 전부 클린
- [x] pnpm test 전체 통과 (377개)

### 최종 결과

| 기능             | v0.1.x           | v0.2.0                       |
| ---------------- | ---------------- | ---------------------------- |
| 토글 내부 콘텐츠 | ❌ 누락          | ✅ 완벽                      |
| 중첩 토글        | ❌ 누락          | ✅ 완벽                      |
| 위키링크 [[]]    | ❌ 영구 파괴     | ✅ 페이지 멘션 왕복          |
| 이미지 Push      | ❌ 플레이스홀더  | ✅ 실제 업로드               |
| 프론트매터       | ⚠️ 특수문자 깨짐 | ✅ YAML 무손실               |
| 파일 이동        | ❌ 무시          | ✅ 경로+Notion 동시 업데이트 |
| 거짓 변경 감지   | ❌ 재Pull        | ✅ 정확한 timestamp          |
| 크래시 복구      | ❌ 중복          | ✅ 자동 정리                 |
| 콜아웃 별칭      | ❌ 변경          | ✅ 원본 유지                 |

---

## Phase 의존성

```
Phase 1 (Markdown API 전환)
    ├── Phase 2 (위키링크 매핑) ← Phase 1의 enhanced-md-converter 필요
    ├── Phase 3 (이미지 업로드) ← Phase 1의 SDK 5.21.0 필요
    └── Phase 4 (엔진 버그 수정) ← Phase 1의 orchestrator 변경 기반
            ↓
        Phase 5 (프론트매터 보존) ← Phase 2의 위키링크 보존 필요
            ↓
        Phase 6 (테스트 + 릴리스) ← 전부 완료 후
```

**예상 총 작업량: 12-16일**
