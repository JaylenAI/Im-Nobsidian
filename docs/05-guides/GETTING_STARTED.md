# Getting Started / 빠른 시작 가이드

## Prerequisites / 사전 준비

- **Node.js 22.13+** — [nodejs.org](https://nodejs.org)에서 설치
- **Notion 계정** — [notion.so](https://www.notion.so)에서 가입
- **Obsidian vault** — 동기화할 Obsidian 볼트 경로

## Installation / 설치

### Quick Install / 빠른 설치

```bash
# Linux, macOS, WSL2, Termux
curl -fsSL https://raw.githubusercontent.com/JaylenAI/Im-Nobsidian/main/scripts/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/JaylenAI/Im-Nobsidian/main/scripts/install.ps1 | iex
```

### npm

```bash
npm install -g im-nobsidian
```

### npx (설치 없이 실행)

```bash
npx im-nobsidian sync
```

## Step 1: Create Notion Integration / Notion 통합 생성

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) 접속
2. **"New integration"** 클릭 → 이름 입력 → Submit
3. **Internal Integration Secret** 복사 (`ntn_`로 시작)

## Step 2: Connect Your Page / 페이지 연결

Notion에서 동기화할 페이지 열기 → 우상단 `···` → **Connections** → 생성한 통합 추가

> **중요**: 통합을 연결하지 않으면 API 접근이 차단됩니다.

## Step 3: Initialize / 초기화

```bash
cd ~/your-obsidian-vault
nobsi init
```

대화형 설정이 시작됩니다:

1. Notion 토큰 입력 → 자동 검증
2. 사용 가능한 페이지 목록 표시 → 루트 페이지 선택
3. `.im-nobsidian/config.json` 자동 생성

### Non-interactive mode / 비대화형 모드 (CI/스크립트용)

```bash
nobsi init --token ntn_xxx --root-page-id abc123 --non-interactive
```

## Step 4: Sync / 동기화

```bash
nobsi sync           # 양방향 (Pull → Push)
nobsi push           # Obsidian → Notion
nobsi pull           # Notion → Obsidian
nobsi watch          # 파일 변경 감지 → 자동 동기화
```

### Dry Run / 미리보기

```bash
nobsi sync --dry-run   # 실제 변경 없이 예정 작업만 확인
```

## Step 5: Check Status / 상태 확인

```bash
nobsi status         # 변경/충돌 파일 표시
nobsi diff           # 로컬 ↔ Notion 차이 상세 출력
```

## Conflict Resolution / 충돌 해결

양쪽에서 같은 파일을 수정하면 충돌이 발생합니다:

```bash
nobsi resolve        # 대화형 충돌 해결
nobsi resolve --strategy local-first   # 로컬 우선
nobsi resolve --strategy remote-first  # Notion 우선
```

## Folder Structure / 폴더 구조

Obsidian 폴더 구조가 Notion 페이지 계층에 1:1로 매핑됩니다:

```
Obsidian                          Notion
projects/                    →    📄 projects
  plan.md                    →      📄 plan
  notes.md                   →      📄 notes
meeting.md                   →    📄 meeting
```

## Ignore Files / 파일 제외

`.im-nobsidian-ignore` 파일을 볼트 루트에 생성합니다 (.gitignore 형식):

```
# 템플릿 제외
templates/

# 일기 제외
daily/**

# 특정 파일 제외
private-note.md
```

## Next Steps / 다음 단계

- [Configuration Guide](CONFIGURATION.md) — 상세 설정 옵션
- [CLI Commands](../04-api/CLI_COMMANDS.md) — 전체 명령어 레퍼런스
- [Troubleshooting](TROUBLESHOOTING.md) — 문제 해결
