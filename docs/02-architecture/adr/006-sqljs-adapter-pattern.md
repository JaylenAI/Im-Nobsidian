# ADR-006: sql.js 어댑터 패턴으로 StateDB 환경 분리

## 상태

승인 (2026-05-18)

## 컨텍스트

ADR-002에서 better-sqlite3를 선택했고, ADR-004에서 Electron 호환 문제를 인지했다.
v0.2.0에서 Obsidian 플러그인을 프로덕션 릴리스하므로, 이 문제를 해결해야 한다.

better-sqlite3는 네이티브 C++ 바인딩을 사용하며, Obsidian(Electron) 샌드박스에서 로드 불가.
플러그인이 `import Database from "better-sqlite3"` 시점에 즉시 크래시.

## 결정

**어댑터 패턴 도입 + sql.js(WASM) 구현체 추가.**

```
core 패키지: IStateDB 인터페이스 (24개 메서드)
    ├── BetterSqliteStateDB (CLI용, 네이티브, 고성능)
    └── SqlJsStateDB (플러그인용, WASM, Electron 호환)
```

## 이유

1. **CLI 성능 보존**: CLI는 계속 better-sqlite3 사용 (5-10x 빠름)
2. **플러그인 호환**: sql.js(WASM)는 네이티브 바인딩 없이 모든 플랫폼에서 동작
3. **기존 코드 최소 변경**: SyncOrchestrator 등은 `IStateDB` 타입만 받으면 됨
4. **SQL 호환**: sql.js도 SQLite 3 엔진 — 기존 마이그레이션 SQL 그대로 사용

## 대안 검토

### A: electron-rebuild로 better-sqlite3 재빌드

- 장점: 성능 최고, 코드 변경 없음
- 단점: Obsidian 버전 업그레이드마다 ABI 불일치 위험, 사용자 빌드 환경 의존

### B: IndexedDB (브라우저 API)

- 장점: 외부 의존성 없음
- 단점: SQL 쿼리 기능 상실, StateDB 24개 메서드 전면 재작성

### C: JSON 파일 저장

- 장점: 단순
- 단점: ACID 미보장, 대규모 매핑에서 성능 저하

→ **어댑터 패턴 + sql.js가 최소 변경 + 최대 호환성**

## 기술 세부사항

### sql.js 특이사항

- WAL 모드 미지원 → DELETE 저널 모드 사용
- 인메모리 DB → 디스크 persistence 별도 구현 필요 (debounce flush)
- `Buffer` → `Uint8Array` (Buffer는 Uint8Array 서브클래스이므로 호환)
- WASM 파일 (~1MB) 플러그인 디렉토리에 동봉

### 변경 범위

- `core/src/state/`: 인터페이스 추출 + 리네임 (기존 로직 변경 없음)
- `core/src/sync/`, `core/src/conflict/`: 타입 시그니처만 변경
- `obsidian-plugin/src/state/`: SqlJsStateDB 신규 구현
- `obsidian-plugin/src/main.ts`: 초기화 로직 변경
- **테스트, CLI, Notion API, 변환 엔진**: 변경 없음

## 결과

- CLI: `BetterSqliteStateDB` (= 기존 `StateDB`) 유지
- Plugin: `SqlJsStateDB` 사용
- core 패키지에서 better-sqlite3 의존성은 유지 (CLI가 사용)
- 동일한 `.im-nobsidian/sync.db` 파일을 CLI와 플러그인이 공유 가능 (SQLite 3 형식 호환)
