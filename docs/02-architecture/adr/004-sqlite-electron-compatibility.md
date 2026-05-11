# ADR-004: better-sqlite3 Electron 호환성

## 상태

논의 중 (2026-05-11)

## 컨텍스트

`@obsinotion/core`는 동기화 상태를 better-sqlite3 (네이티브 Node.js 모듈)로 관리한다.
Obsidian은 Electron 기반이므로, better-sqlite3의 네이티브 바인딩이 Electron의 Node.js ABI와 맞지 않으면 로딩 실패한다.
현재 esbuild.config.mjs에서 better-sqlite3를 external로 처리하고 있으나, 사용자가 네이티브 모듈을 수동 설치하는 건 비현실적.

## 대안

### A: electron-rebuild로 better-sqlite3 재빌드

- 릴리스 시 Electron 버전에 맞춰 prebuild 포함
- 장점: 성능 최고
- 단점: Obsidian 버전 업그레이드 시 ABI 불일치 위험, 빌드 복잡

### B: sql.js (WASM 기반)

- better-sqlite3를 sql.js로 교체
- 장점: 네이티브 바인딩 없음, 모든 플랫폼 호환
- 단점: 동기 API → 비동기 API 변환 필요, 대규모 DB에서 성능 저하

### C: IndexedDB 사용 (브라우저 API)

- Obsidian이 제공하는 `this.app.vault.adapter` 기반 JSON 파일 저장
- 장점: 외부 의존성 없음
- 단점: SQL 쿼리 기능 상실, 상태 관리 로직 전면 재작성

## 결정

**미결정** — v0.1.0은 CLI만 배포 (better-sqlite3 정상 동작).
플러그인 배포 (v0.5.0) 전까지 B안(sql.js)으로의 마이그레이션을 검토한다.

## 결과

- CLI: better-sqlite3 유지 (네이티브 성능)
- Plugin: sql.js 또는 core에 DB 어댑터 인터페이스 도입하여 환경별 구현 분리
