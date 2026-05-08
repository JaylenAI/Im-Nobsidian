# 용어 정의

> 프로젝트 전체에서 통일된 용어 사용을 위한 문서

## 핵심 개념

| 용어 | 정의 |
|------|------|
| **Vault** | Obsidian 볼트. 로컬 파일 시스템의 마크다운 파일 모음 |
| **Workspace** | Notion 워크스페이스. 페이지/DB의 최상위 컨테이너 |
| **Root Page** | Notion에서 동기화 대상 최상위 페이지 |
| **Sync Pair** | 로컬 파일 ↔ Notion 페이지의 1:1 매핑 관계 |
| **Sync State** | 마지막 동기화 시점의 상태 (해시, 타임스탬프) |
| **Base Snapshot** | 3-way merge를 위한 기준 버전 (마지막 동기화 시점의 콘텐츠) |

## Notion 개념

| 용어 | 정의 |
|------|------|
| **Block** | Notion의 기본 콘텐츠 단위 (문단, 제목, 리스트 등) |
| **Page** | Block의 컨테이너. 자체가 Block이기도 함 (child_page) |
| **Database** | 구조화된 페이지 모음 (테이블, 보드, 캘린더 뷰) |
| **Property** | Database 엔트리의 메타데이터 필드 (제목, 태그, 날짜 등) |
| **Relation** | Database 간 참조 관계 |
| **Rollup** | Relation을 통한 집계 값 |
| **Mention** | 페이지/사용자/날짜에 대한 인라인 참조 |
| **Callout** | 아이콘 + 배경색이 있는 강조 블록 |
| **Synced Block** | 여러 페이지에서 동일 내용을 공유하는 블록 |
| **Toggle** | 접기/펼치기 가능한 블록 |

## Obsidian 개념

| 용어 | 정의 |
|------|------|
| **Wikilink** | `[[페이지명]]` 형식의 내부 링크 |
| **Alias** | `[[페이지명\|표시텍스트]]`에서 표시텍스트 부분 |
| **Embed** | `![[페이지명]]` 형식의 노트 삽입 |
| **Frontmatter** | 파일 상단 `---` 사이의 YAML 메타데이터 |
| **Callout** | `> [!type] 제목` 형식의 강조 블록 |
| **Dataview** | 동적 데이터 조회 플러그인 구문 |
| **Templater** | 템플릿 자동화 플러그인 구문 |
| **Graph View** | 노트 간 연결을 시각화하는 그래프 |
| **Tag** | `#태그` 형식의 분류 표시 |

## 동기화 용어

| 용어 | 정의 |
|------|------|
| **Push** | 로컬 → Notion 방향 전송 |
| **Pull** | Notion → 로컬 방향 전송 |
| **Sync** | 양방향 동기화 (push + pull) |
| **Delta Sync** | 변경된 파일만 동기화 (전체 재동기화 아님) |
| **Full Sync** | 전체 파일 비교 + 동기화 |
| **Conflict** | 양쪽 모두 마지막 동기화 이후 변경된 상태 |
| **Conflict Copy** | 충돌 시 생성되는 백업 파일 (`.obsinotion-conflict`) |
| **Roundtrip** | A→B→A 왕복 변환 후 원본과 동일한지 검증 |
| **Preserve Marker** | 변환 불가 기능을 보존하는 HTML 주석 마커 |
| **LWW** | Last-Write-Wins. 최신 타임스탬프 우선 전략 |
| **3-Way Merge** | base + local + remote 3개 버전 비교 병합 |

## 변환 등급

| 등급 | 정의 | 예시 |
|------|------|------|
| **A등급** | 양방향 완벽 변환 (손실 0%) | 제목, 리스트, 볼드, 코드블록 |
| **B등급** | 양방향 변환 가능, 미세 손실 (5-15%) | 콜아웃, 수식, 테이블 |
| **C등급** | 한쪽 전용, 보존 마커로 라운드트립 | Dataview, Relations, 컬럼 레이아웃 |

## 패키지명

| 패키지 | npm 이름 | 역할 |
|--------|---------|------|
| core | `@obsinotion/core` | 변환 + 동기화 엔진 |
| cli | `obsinotion` | CLI 도구 |
| obsidian-plugin | `obsidian-obsinotion` | Obsidian 플러그인 |
