# ADR-002: SQLite로 동기화 상태 관리

> 상태: 승인
> 결정일: 2026-05-08

## 맥락

동기화 엔진은 마지막 동기화 상태(해시, 타임스탬프, 페이지 매핑)를 영속적으로 저장해야 한다.

## 결정

**better-sqlite3 (네이티브 SQLite)** 사용.

## 이유

1. **제로 인프라**: 별도 서버 없이 단일 파일 (.db)
2. **ACID**: 트랜잭션 보장, WAL 모드로 동시 읽기
3. **성능**: 동기식 API로 메타데이터 조회 빠름
4. **이식성**: DB 파일을 볼트와 함께 이동 가능
5. **better-sqlite3 선택 이유**: node-sqlite3 대비 5-10배 빠름, 동기식 API

## 대안 검토

- **sql.js (WASM)**: Obsidian 플러그인에서는 유리하나, Node.js에서는 네이티브 대비 느림
- **JSON 파일**: 대규모 매핑에서 성능 저하, ACID 미보장
- **LevelDB**: 키-값만 지원, 복잡한 쿼리 불가
- **프론트매터에 ID 저장** (Nobsidion 방식): 파일 오염, 사용자 프론트매터와 충돌

## 결과

- `packages/core/src/state/` 모듈에서 DB 관리
- `.im-nobsidian/sync.db`로 볼트 내 저장
- 마이그레이션 시스템 (`state/migrations/`)
