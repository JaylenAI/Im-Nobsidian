# v0.2.0 — Obsidian 플러그인 프로덕션 릴리스 계획

> 작성: 2026-05-18
> 상태: 진행 중 (Phase 1 시작 전)
> 이전: PHASE_PLAN_v0.2.0_VIEW_RENDERING.md (뷰 렌더링 엔진 — 완료)

## 배경

v0.1.5까지 CLI + core 라이브러리 개발 완료. 뷰 렌더링 엔진(Gallery/Board/Table/Calendar)도 코드 완성.
하지만 **Obsidian 플러그인은 better-sqlite3 네이티브 모듈 때문에 실제 로드 불가**.
이 계획은 플러그인을 프로덕션 품질로 완성하여 **커뮤니티 플러그인 디렉토리에 등록**하는 것이 목표.

## 현재 문제점

### 치명적 결함 6건 (커뮤니티 심사 차단)

| #   | 문제                                            | 파일:라인                       | 해결 Phase |
| --- | ----------------------------------------------- | ------------------------------- | ---------- |
| 1   | better-sqlite3 네이티브 → Electron 크래시       | `core/src/state/state-db.ts:1`  | Phase 1-2  |
| 2   | manifest id에 "obsidian" 포함 → 심사 거부       | `obsidian-plugin/manifest.json` | Phase 3    |
| 3   | `containerEl.children[1]` 비공식 접근           | `views/database-view.ts:67`     | Phase 3    |
| 4   | `createEl("h2")` 대신 `setHeading()` 필요       | `settings.ts:16`                | Phase 3    |
| 5   | `detachLeavesOfType()` 사용자 레이아웃 리셋     | `main.ts:120`                   | Phase 3    |
| 6   | manifest 0.1.0 ≠ package.json 0.1.4 버전 불일치 | manifest.json / package.json    | Phase 3    |

### 구조적 과제

- StateDB 24개 메서드가 better-sqlite3 동기 API에 직접 의존
- 어댑터 인터페이스 부재 → CLI/플러그인 환경 분리 불가
- 사이드바/리본 아이콘/필터 UI 등 UX 요소 미구현
- 플러그인 패키지 테스트 0개

---

## Phase 구성

### Phase 1: StateDB 어댑터 인터페이스 분리 ⬜

**브랜치**: `feature/statedb-adapter-interface`

| 작업                                          | 파일                                       | 상태 |
| --------------------------------------------- | ------------------------------------------ | ---- |
| `IStateDB` 인터페이스 정의 (24메서드)         | `core/src/state/state-db-interface.ts`     | ⬜   |
| `StateDB` → `BetterSqliteStateDB` 리네임      | `core/src/state/better-sqlite-state-db.ts` | ⬜   |
| `StateDB` re-export 유지 (CLI 호환)           | `core/src/state/index.ts`                  | ⬜   |
| 소비자 타입 변경 (Orchestrator 등 6개 클래스) | `sync/*.ts`, `conflict/*.ts`               | ⬜   |
| `IStateDB` export 추가                        | `core/src/index.ts`                        | ⬜   |

**IStateDB 인터페이스 (24개 메서드)**:

```typescript
interface IStateDB {
  // sync_state CRUD
  getByPath(path: string): SyncRecord | null;
  getByNotionId(pageId: string): SyncRecord | null;
  getByStatus(status: SyncStatus): SyncRecord[];
  getAll(): SyncRecord[];
  upsert(record: UpsertSyncRecord): SyncRecord;
  updateStatus(id: string, status: SyncStatus): void;
  updateHash(id: string, hash: string, snapshot?: Uint8Array | null): void;
  setNotionLastEdited(id: string, lastEdited: string): void;
  setNotionParentId(id: string, parentId: string): void;
  delete(id: string): void;

  // wikilink_map
  resolveWikilink(text: string): WikilinkEntry | null;
  resolvePageId(pageId: string): WikilinkEntry | null;
  upsertWikilink(entry: WikilinkEntry): void;

  // sync_metadata
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  // file_registry
  isFileRegistered(localPath: string): boolean;
  getFileRegistry(localPath: string): FileRegistryEntry | null;
  getFilesByPageId(notionPageId: string): FileRegistryEntry[];
  registerFile(entry: RegisterFileInput): void;
  deleteFileRegistry(localPath: string): void;

  // preserve_markers
  storePreserveMarkers(path: string, markers: PreserveMarker[]): void;
  getPreserveMarkers(path: string): PreserveMarker[];

  // transaction + lifecycle
  transaction<T>(fn: () => T): T;
  close(): void;
}
```

**소비자 클래스 (타입 변경 대상)**:

- `SyncOrchestrator` — 23개 메서드 호출, 가장 무거운 소비자
- `ConflictResolver` — `updateHash()`, `updateStatus()` 3개 메서드
- `ChangeDetector` — `getByPath()`, `getByStatus()` 2개 메서드
- `FileHandler` — file_registry 메서드 4개
- `DatabaseSyncer` — `upsert()`, `updateHash()`, `upsertWikilink()` 등
- `EntryEditor` — StateDB 미사용 (VaultFS만 사용)

**검증**: 553 테스트 전부 통과, typecheck 클린, CLI 정상 동작

---

### Phase 2: sql.js WASM 어댑터 구현 ⬜

**브랜치**: `feature/sqljs-wasm-adapter`
**의존**: Phase 1

| 작업                                  | 파일                                          | 상태 |
| ------------------------------------- | --------------------------------------------- | ---- |
| sql.js 의존성 추가                    | `obsidian-plugin/package.json`                | ⬜   |
| `SqlJsStateDB` 클래스 (IStateDB 구현) | `obsidian-plugin/src/state/sqljs-state-db.ts` | ⬜   |
| DB persistence 레이어                 | `obsidian-plugin/src/state/db-persistence.ts` | ⬜   |
| esbuild better-sqlite3 external 제거  | `obsidian-plugin/esbuild.config.mjs`          | ⬜   |
| main.ts SqlJsStateDB 사용             | `obsidian-plugin/src/main.ts`                 | ⬜   |
| SqlJsStateDB 단위 테스트 15+          | `obsidian-plugin/tests/state/`                | ⬜   |

**better-sqlite3 vs sql.js API 매핑**:

| better-sqlite3                | sql.js                                       | 비고                           |
| ----------------------------- | -------------------------------------------- | ------------------------------ |
| `new Database(path)`          | `new SQL.Database(data)`                     | data = Uint8Array (파일 내용)  |
| `db.prepare(sql).get(params)` | `db.prepare(sql).bind(params).getAsObject()` | 반환 타입 동일                 |
| `db.prepare(sql).all(params)` | 수동 루프 (step → getAsObject)               | 헬퍼 메서드 필요               |
| `db.prepare(sql).run(params)` | `db.run(sql, params)`                        |                                |
| `db.exec(sql)`                | `db.exec(sql)`                               | 동일                           |
| `db.pragma("...")`            | `db.run("PRAGMA ...")`                       |                                |
| `db.transaction(fn)()`        | `BEGIN; fn(); COMMIT;`                       | 수동 구현                      |
| `db.close()`                  | `db.close()` + flush                         | export → 저장 필요             |
| `Buffer` (BLOB)               | `Uint8Array`                                 | Buffer는 Uint8Array 서브클래스 |

**Persistence 전략**:

- 초기 로드: vault adapter → `.im-nobsidian/sync.db` 읽기 → `new SQL.Database(data)`
- 변경 시: 5초 debounce → `db.export()` → vault adapter 저장
- unload 시: 즉시 flush
- WAL 모드 비활성화 (sql.js 미지원) → DELETE 저널 모드

**검증**: SqlJsStateDB 15+ 테스트, 플러그인 빌드에 better-sqlite3 참조 0건

---

### Phase 3: 커뮤니티 플러그인 심사 요건 충족 ⬜

**브랜치**: `feature/plugin-compliance`
**의존**: Phase 2

| 작업                                         | 파일                            | 상태 |
| -------------------------------------------- | ------------------------------- | ---- |
| manifest id → `im-notion-sync`               | `manifest.json`                 | ⬜   |
| 버전 통일 → 0.2.0                            | `manifest.json`, `package.json` | ⬜   |
| `containerEl.children[1]` → `this.contentEl` | `database-view.ts:67`           | ⬜   |
| `createEl("h2")` → `setHeading()`            | `settings.ts:16`                | ⬜   |
| `detachLeavesOfType()` 제거                  | `main.ts:120`                   | ⬜   |
| Token input → password 타입                  | `settings.ts`                   | ⬜   |
| `minAppVersion` → `1.9.0`                    | `manifest.json`                 | ⬜   |

**검증**: Obsidian v1.12+에서 플러그인 크래시 없이 로드

---

### Phase 4: 사이드바 + 리본 + UI 강화 ⬜

**브랜치**: `feature/sidebar-ribbon-ui`
**의존**: Phase 3

| 작업                            | 파일                         | 상태 |
| ------------------------------- | ---------------------------- | ---- |
| SyncSidebarView (ItemView)      | `views/sync-sidebar-view.ts` | ⬜   |
| SyncDashboard.svelte            | `views/SyncDashboard.svelte` | ⬜   |
| 리본 아이콘 등록                | `main.ts`                    | ⬜   |
| 사이드바 뷰 등록                | `main.ts`                    | ⬜   |
| 설정 탭 확장 (충돌전략, DB목록) | `settings.ts`                | ⬜   |
| 진행률 콜백 연결                | `main.ts`                    | ⬜   |

**사이드바 구성 요소**:

```
┌──────────────────────┐
│ ● Synced 5m ago      │
│ 17 pages · 1 db      │
├──────────────────────┤
│ [Sync] [Pull] [Push] │
├──────────────────────┤
│ ▓▓▓▓▓░░░░░ 50%      │
│ Pushing: note.md     │
├──────────────────────┤
│ ⚠ 2 Conflicts        │
│   • meeting.md       │
│   • project.md       │
├──────────────────────┤
│ [Settings] [Views]   │
└──────────────────────┘
```

---

### Phase 5: 뷰 렌더링 고급 기능 ⬜

**브랜치**: `feature/advanced-view-features`
**의존**: Phase 3

| 작업                      | 파일                         | 상태 |
| ------------------------- | ---------------------------- | ---- |
| Filter/Sort/Search 도구바 | `ViewToolbar.svelte`         | ⬜   |
| `filterEntries()` 함수    | `core/view/filter-engine.ts` | ⬜   |
| 인라인 테이블 편집        | `TableView.svelte`           | ⬜   |
| DB 선택 모달              | `DatabasePicker.svelte`      | ⬜   |
| "+ 새 항목" 버튼          | 각 View 컴포넌트             | ⬜   |
| List 뷰                   | `ListView.svelte`            | ⬜   |
| Timeline 뷰               | `TimelineView.svelte`        | ⬜   |

**도구바 와이어프레임**:

```
┌─────────────────────────────────────────────────┐
│ ⊞ Gallery ∨  │ ↕ Sort │ ≡ Filter │ 🔍 Search  │
└─────────────────────────────────────────────────┘
```

---

### Phase 6: 플러그인 테스트 50+ ⬜

**브랜치**: `feature/plugin-tests`
**의존**: Phase 4, 5

| 작업                          | 파일                               | 상태 |
| ----------------------------- | ---------------------------------- | ---- |
| 테스트 인프라 (vitest + mock) | `obsidian-plugin/vitest.config.ts` | ⬜   |
| Obsidian API 모킹 헬퍼        | `tests/helpers/mock-obsidian.ts`   | ⬜   |
| SqlJsStateDB 테스트 확장      | `tests/state/`                     | ⬜   |
| VaultAdapter 테스트 10+       | `tests/vault-adapter.test.ts`      | ⬜   |
| Plugin 통합 테스트 10+        | `tests/main.test.ts`               | ⬜   |
| Svelte 컴포넌트 테스트 15+    | `tests/views/`                     | ⬜   |

**목표**: 전체 프로젝트 620+ 테스트

---

### Phase 7: 문서 + 폴리싱 + BRAT 베타 ⬜

**브랜치**: `feature/docs-polish-beta`
**의존**: Phase 4, 5, 6

| 작업                                           | 상태 |
| ---------------------------------------------- | ---- |
| 플러그인 README.md (영어 + 한국어)             | ⬜   |
| 스크린샷/GIF 6장+                              | ⬜   |
| styles.css 확장 (다크/라이트 호환)             | ⬜   |
| 빌드 최적화 (main.js 사이즈, WASM 복사 자동화) | ⬜   |
| BRAT 릴리스                                    | ⬜   |
| E2E 수동 테스트 체크리스트                     | ⬜   |

---

### Phase 8: 커뮤니티 플러그인 제출 ⬜

**브랜치**: `release/v0.2.0`
**의존**: Phase 1-7 전부

| 작업                                   | 상태 |
| -------------------------------------- | ---- |
| 최종 빌드 + 품질 게이트                | ⬜   |
| GitHub Release v0.2.0 태그             | ⬜   |
| `obsidianmd/obsidian-releases` PR 제출 | ⬜   |
| 심사 피드백 대응                       | ⬜   |

---

## 의존 관계

```
Phase 1 (어댑터 인터페이스)
    ↓
Phase 2 (sql.js 구현)
    ↓
Phase 3 (심사 요건) ──→ Phase 4 (사이드바/UI) ──┐
    │                                            │
    └──→ Phase 5 (뷰 고급) ─────────────────────┤
                                                  ↓
                                     Phase 6 (테스트 50+)
                                                  ↓
                                     Phase 7 (문서+베타)
                                                  ↓
                                     Phase 8 (커뮤니티 제출)
```

---

## 데이터 흐름 (sql.js 전환 후)

```
Notion API
    │
    ├── Pages/DB ──→ SyncOrchestrator ──→ IStateDB ──┐
    │                                                  │
    ├── Views API ──→ db-views.json                    ├── CLI: BetterSqliteStateDB
    │                                                  │         (네이티브, 고성능)
    └── Cover/Icon ──→ 로컬 이미지                      │
                                                       └── Plugin: SqlJsStateDB
                                                                (WASM, Electron 호환)
```

## 최종 도달 수준 (v0.2.0)

| 항목                   | 현재 (v0.1.5) |                  목표 (v0.2.0)                   |
| ---------------------- | :-----------: | :----------------------------------------------: |
| Obsidian 플러그인 로드 |   ❌ 크래시   |                     ✅ 정상                      |
| DB 뷰 렌더링           | 4종 (미검증)  | 6종 (Gallery/Board/Table/Calendar/List/Timeline) |
| Filter/Sort/Search UI  |      ❌       |                    ✅ 도구바                     |
| 인라인 편집            |      ❌       |                   ✅ Table 셀                    |
| 사이드바 대시보드      |      ❌       |             ✅ Push/Pull/상태/진행률             |
| 리본 아이콘            |      ❌       |                 ✅ 원클릭 동기화                 |
| 커뮤니티 플러그인 등록 |      ❌       |                   ✅ 심사 통과                   |
| 테스트                 |      553      |                       620+                       |
| 오픈소스 배포          |      ❌       |                 ✅ GitHub + npm                  |

## 경쟁 환경 (2026.05 기준)

**Notion Views API를 활용하여 DB 뷰를 Obsidian에서 렌더링하는 플러그인은 전세계에 0개.**
기존 동기화 도구는 전부 "프론트매터/텍스트만 동기화" 또는 "로컬 전용 뷰 렌더러".
Im-Nobsidian v0.2.0이 이 영역의 최초 제품이 된다.

| 도구                             |  뷰 렌더링   | Notion 연동  | 양방향 |
| -------------------------------- | :----------: | :----------: | :----: |
| Im-Nobsidian v0.2.0              |    ✅ 6종    | ✅ Views API |   ✅   |
| Obsidian Bases (내장)            |   ✅ 11종+   |      ❌      |   -    |
| MAKE.md                          |   ✅ 11종    |      ❌      |   -    |
| Notion Bases (bgarciamoura)      |    ✅ 7종    |      ❌      |   -    |
| Notion Database Sync (ran-codes) | ❌ (.base만) |  ✅ Pull만   |   ❌   |
| Notion Sync (j-palindrome)       |      ❌      |  ✅ 속성만   |   ⚠️   |
