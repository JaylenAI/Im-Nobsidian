<p align="center">
  <img src="assets/banner.png" alt="Im-Nobsidian" width="600" />
</p>

<h1 align="center">Im-Nobsidian</h1>

<p align="center">
  <strong>세계 최초이자 유일한 Obsidian ↔ Notion 양방향 동기화 도구.</strong>
</p>

<p align="center">
  <a href="https://github.com/JaylenAI/Im-Nobsidian/actions/workflows/ci.yml"><img src="https://github.com/JaylenAI/Im-Nobsidian/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/im-nobsidian"><img src="https://img.shields.io/npm/v/im-nobsidian" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-22%2B-green" alt="Node.js" /></a>
  <a href="https://www.npmjs.com/package/im-nobsidian"><img src="https://img.shields.io/npm/dm/im-nobsidian" alt="npm downloads" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="docs/06-devlog/CHANGELOG.md">변경 이력</a> · <a href="CONTRIBUTING.md">기여 가이드</a> · <a href="SECURITY.md">보안 정책</a>
</p>

---

Obsidian에서 편집하면 Notion에 반영됩니다. Notion에서 편집하면 Obsidian에 반영됩니다. 복사-붙여넣기도, 내보내기-가져오기도, 수동 동기화도 필요 없습니다. `nobsi sync` 한 번이면 양쪽이 완벽하게 동기화됩니다 — 서식, 속성, 폴더 구조 모두.

모든 경쟁 도구는 단방향입니다. Im-Nobsidian은 진정한 **양방향** 동기화와 충돌 해결, 속성 매핑, 왕복 보존을 제공하는 최초이자 유일한 오픈소스 프로젝트입니다.

## 주요 특징

**진정한 양방향 동기화** &nbsp; 어느 쪽에서 편집하든 양쪽에 반영됩니다. "내보내고 가져오기"가 아닌, 변경 감지와 델타 업데이트 기반의 실제 양방향 동기화입니다.

**25+ 블록 타입 보존** &nbsp; 제목, 코드 블록, 수식(LaTeX), 콜아웃, 토글, 테이블, 체크리스트, 컬럼, 구분선, 임베드, 미디어(audio/video/pdf/file), 탭 블록 — 모두 양방향으로 정확하게 변환됩니다. 색상, 밑줄, Notion 전용 블록은 보존 마커로 라운드트립이 보장됩니다.

**스마트 부분 업데이트** &nbsp; 변경이 적을 때는 전체 덮어쓰기 대신 search-and-replace로 부분 업데이트합니다. 같은 페이지에서 다른 사람이 편집한 내용이 보존됩니다.

**프론트매터 ↔ Notion 속성** &nbsp; YAML 프론트매터가 Notion 데이터베이스 속성에 직접 매핑됩니다. 21종 읽기 + 15종 쓰기를 지원하며, 읽기전용 속성(formula, rollup 등)은 자동으로 스킵됩니다.

**충돌 해결 내장** &nbsp; 양쪽에서 같은 파일을 수정하면 Im-Nobsidian이 감지하고, 실제 원격 내용을 비교하여 보여줍니다. 로컬 유지 / 원격 유지 / 수동 해결 중 선택할 수 있습니다. 데이터 유실은 절대 없습니다.

**다중 데이터베이스 동기화** &nbsp; 여러 Notion 데이터베이스를 각각 별도 로컬 폴더에 동기화합니다. 데이터베이스별 속성 매핑과 필터를 설정할 수 있으며, 데이터베이스 페이지가 프론트매터 속성을 가진 개별 마크다운 파일이 됩니다.

**파일 첨부 자동 다운로드** &nbsp; Notion의 Excel, PDF, Jupyter Notebook 등 파일 첨부가 자동으로 로컬 볼트에 다운로드됩니다. 내부 `file://` 프로토콜 링크도 Notion API를 통해 해석되어 로컬에 저장됩니다.

**깊은 자식 페이지 탐색** &nbsp; 리스트, 문단, 제목, 토글 등 어떤 블록 안에 중첩된 자식 페이지도 발견하여 동기화합니다. 최상위 자식만이 아닌, 계층 구조의 모든 페이지를 찾아냅니다.

**폴더 구조 = 페이지 계층** &nbsp; Obsidian 폴더 트리가 Notion 페이지 계층에 1:1로 매핑됩니다. `프로젝트/기획안.md` → Notion "프로젝트" 하위 "기획안" 페이지.

**설정 없는 상태 관리** &nbsp; 데이터베이스 설치도, 서버 실행도 필요 없습니다. `.im-nobsidian/` 폴더의 로컬 SQLite 파일로 자동 관리되며, 유저가 만질 일은 없습니다.

**Notion DB → Obsidian Bases** &nbsp; Notion 데이터베이스가 자동으로 Obsidian Bases `.base` 파일로 변환됩니다. 갤러리 뷰는 `file.embeds[0]` formula로 커버 이미지가 자동 표시됩니다. 테이블, 카드, 리스트 뷰와 정렬/그룹핑/속성 순서가 Notion Views API에서 매핑됩니다.

**라이브러리 + CLI + 플러그인** &nbsp; CLI 도구로 사용하거나, Node.js 라이브러리로 커스텀 연동을 만들거나, Obsidian 플러그인으로 설치할 수 있습니다.

## 빠른 설치

### Linux, macOS, WSL2, Termux

```bash
curl -fsSL https://raw.githubusercontent.com/JaylenAI/Im-Nobsidian/main/scripts/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/JaylenAI/Im-Nobsidian/main/scripts/install.ps1 | iex
```

### 직접 설치

Node.js 22+가 이미 있다면:

```bash
npm install -g im-nobsidian
```

설치 없이 바로 실행:

```bash
npx im-nobsidian sync
```

## 시작하기

### 1. Notion Integration 생성

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) 접속
2. **"새 통합 만들기"** 클릭 → 이름 입력 → 제출
3. **Internal Integration Secret** 복사 (`ntn_`으로 시작)

### 2. 페이지에 연결

Notion에서 동기화할 페이지 열기 → 우측 상단 `···` → **연결** → 생성한 통합 추가

### 3. 초기화

```bash
cd ~/your-obsidian-vault
nobsi init
```

대화형 설정이 토큰을 묻고, 사용 가능한 페이지를 보여줍니다. 선택하면 끝입니다.

### 4. 동기화

```bash
nobsi sync     # 양방향 — pull 후 push
nobsi push     # Obsidian → Notion만
nobsi pull     # Notion → Obsidian만
nobsi watch    # 파일 변경 감시 + 자동 동기화
```

이제 볼트와 Notion 워크스페이스가 연결되었습니다.

## 실제 동작

<table>
<tr>
<td align="center"><strong>nobsi init</strong></td>
<td align="center"><strong>nobsi sync</strong></td>
</tr>
<tr>
<td><img src="assets/demo/init.gif" alt="nobsi init" width="400" /></td>
<td><img src="assets/demo/sync.gif" alt="nobsi sync" width="400" /></td>
</tr>
<tr>
<td align="center"><strong>nobsi push</strong></td>
<td align="center"><strong>nobsi pull</strong></td>
</tr>
<tr>
<td><img src="assets/demo/push.gif" alt="nobsi push" width="400" /></td>
<td><img src="assets/demo/pull.gif" alt="nobsi pull" width="400" /></td>
</tr>
<tr>
<td align="center"><strong>nobsi status</strong></td>
<td align="center"><strong>nobsi diff</strong></td>
</tr>
<tr>
<td><img src="assets/demo/status.gif" alt="nobsi status" width="400" /></td>
<td><img src="assets/demo/diff.gif" alt="nobsi diff" width="400" /></td>
</tr>
<tr>
<td align="center"><strong>nobsi resolve</strong></td>
<td align="center"><strong>nobsi watch</strong></td>
</tr>
<tr>
<td><img src="assets/demo/resolve.gif" alt="nobsi resolve" width="400" /></td>
<td><img src="assets/demo/watch.gif" alt="nobsi watch" width="400" /></td>
</tr>
</table>

## CLI 명령어

| 명령어              | 설명                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `nobsi init`        | 대화형 설정 — Notion 토큰 + 루트 페이지                               |
| `nobsi push`        | 로컬 변경사항을 Notion에 반영                                         |
| `nobsi pull`        | Notion 변경사항을 로컬에 반영                                         |
| `nobsi sync`        | 양방향 동기화 (pull → push)                                           |
| `nobsi status`      | 동기화 상태 + 충돌 표시                                               |
| `nobsi diff [경로]` | 로컬과 Notion 간 차이 표시                                            |
| `nobsi fetch`       | 원격 변경 스캔 (신규/수정/삭제, 읽기 전용)                            |
| `nobsi verify`      | 완결성 검증 — 원격 행·**페이지**가 볼트에 빠짐없이 있는가 (읽기 전용) |
| `nobsi resolve`     | 동기화 충돌 해결                                                      |
| `nobsi watch`       | 파일 변경 감시 + 자동 동기화                                          |

`push`, `pull`, `sync`는 `--dry-run` 옵션으로 적용 없이 변경사항을 미리 볼 수 있습니다. `pull --force`는 증분 감지를 건너뛰고 전체를 다시 스캔합니다 (Notion 검색 인덱싱 지연으로 누락된 페이지 복구).

`verify`는 `status`와 다른 질문에 답합니다 — "낡은 게 있는가"가 아니라 **"빠진 게 있는가"**입니다.
카운트가 아니라 **집합**을 두 축으로 대조합니다 — database 별 행, 그리고 root 하위 페이지. Notion에는
있는데 로컬에 없는 것이 하나라도 있으면 0이 아닌 코드로 끝납니다. 멱등성 검사(`pull`을 다시 돌려
변경 0을 확인하는 것)로는 이걸 잡을 수 없습니다 — 디스커버리가 매번 **같은 것을 똑같이** 놓치면
재실행 결과도 첫 실행과 같고, churn은 생성·수정만 세기 때문에 **두 번째 열거가 더 작아도** 일치와
구분되지 않습니다. CI 용으로는 `--json`을 붙이세요.

두 축은 **일부러 비대칭**입니다. 행은 로컬에만 있으면 원격 삭제 잔재이므로 실패입니다. 반면 페이지는
로컬 전용 항목을 보고만 하고 **실패로 만들지 않습니다** — 아직 push하지 않은 로컬 노트, root 페이지
자신, Notion 검색 색인 지연이 전부 정상적으로 여기 들어오기 때문입니다. 거짓 적색을 내는 게이트는
곧 무시당해 없는 것과 같아집니다. DB 모드에서는 root 서브트리가 없어 페이지 대조를 건너뜁니다.

### 비대화형 모드 (CI / 스크립트)

```bash
nobsi init --token ntn_xxx --root-page-id abc123 --non-interactive
nobsi sync --dry-run
```

## 동작 원리

```
Obsidian 볼트                          Notion 워크스페이스
┌──────────────┐                    ┌──────────────────┐
│  프로젝트/    │   nobsi push       │  📄 프로젝트      │
│   기획안.md   │  ───────────────►  │    📄 기획안      │
│   메모.md     │                    │    📄 메모        │
│  회의록.md    │  ◄───────────────  │  📄 회의록        │
│              │   nobsi pull       │                   │
└──────────────┘                    └──────────────────┘
        │                                    │
        └──────── nobsi sync ────────────────┘
                    (양방향)
```

### Push (Obsidian → Notion)

1. 볼트의 `.md` 파일 스캔
2. SHA-256 해시로 마지막 동기화 상태와 비교
3. 변경된 파일 변환: 프론트매터 → 속성, 마크다운 → Notion 블록
4. Notion API로 페이지 생성/수정 (3 req/s 제한 준수)

### Pull (Notion → Obsidian)

1. 루트 페이지 하위 페이지를 재귀적으로 읽기
2. `last_edited_time`으로 변경 감지
3. Notion 블록 → 마크다운, 속성 → 프론트매터 변환
4. 이미지를 첨부파일 폴더에 다운로드 (중복 제거)

### 충돌 해결

양쪽에서 같은 파일을 수정하면 `pull`/`sync`가 덮어쓰지 않고 충돌로 표시합니다. `nobsi resolve`를 실행해 파일별로 대화형으로 해결하거나 `--strategy`로 일괄 해결합니다:

- `local-first` — Obsidian 버전 유지
- `remote-first` — Notion 버전 유지
- `duplicate` — 양쪽 모두 유지 (`.conflict` 사본 생성)

대화형 모드에는 **merge** 옵션(충돌 마커를 사용한 3-way 자동 병합)이 추가됩니다. 기본 `sync.conflictStrategy`는 `manual`이며, 충돌은 표시만 되고 직접 해결하도록 남겨둡니다.

## 지원 변환 기능

| 기능                                   |       Push       |    Pull     |
| -------------------------------------- | :--------------: | :---------: |
| 제목, 본문, 볼드/이탤릭/취소선         |        ✅        |     ✅      |
| 코드 블록 (30+ 언어)                   |        ✅        |     ✅      |
| 순서/비순서/체크박스 리스트            |        ✅        |     ✅      |
| 링크 및 위키링크                       |        ✅        |     ✅      |
| 콜아웃 / Notion 콜아웃 블록 (접기)     |        ✅        |     ✅      |
| 수학 수식 (LaTeX, 인라인 + 블록)       |        ✅        |     ✅      |
| 테이블                                 |        ✅        |     ✅      |
| 구분선                                 |        ✅        |     ✅      |
| 토글 블록                              |        ✅        |     ✅      |
| 컬럼 레이아웃                          |        ✅        |     ✅      |
| 색상, 밑줄                             |        ✅        |   ✅ 보존   |
| 미디어 (audio / video / pdf / file)    |        ✅        |     ✅      |
| 탭 블록                                |        ✅        |   ✅ 보존   |
| 비디오 / 임베드 URL                    |        ✅        |     ✅      |
| 프론트매터 ↔ DB 속성 (21종)            |        ✅        |     ✅      |
| 하이라이트 (`==마크==`)                |        ✅        |     ✅      |
| 각주 (`[^1]`)                          |        ✅        |   ✅ 왕복   |
| 표 열 정렬                             |        ✅        |   ✅ 왕복   |
| 옵시디언 주석 (`%%…%%`)                | ✅ Notion 비노출 |   ✅ 복원   |
| 이미지                                 |        ✅        | ✅ 다운로드 |
| 파일 첨부 (xlsx, pdf, ipynb 등)        |        —         | ✅ 다운로드 |
| 커버 이미지 + 아이콘                   |        —         | ✅ 다운로드 |
| Notion 전용 블록 (bookmark, embed 등)  |        ✅        |   ✅ 보존   |
| Notion 전용 블록 (버튼, 폼, 동기 블록) |        —         |   📌 보존   |

## 설정

`nobsi init` 후 설정은 `.im-nobsidian/config.json`에 저장됩니다:

```jsonc
{
  "notion": {
    "token": "ntn_...", // 통합 토큰
    "rootPageId": "...", // 루트 페이지 또는 데이터베이스 ID
    "parentMode": "page", // "page" 또는 "database"
  },
  "sync": {
    "direction": "both", // "push" | "pull" | "both"
    "conflictStrategy": "manual", // "local-first" | "remote-first" | "manual" | "duplicate"
  },
  "paths": {
    "include": ["**/*"], // 포함할 glob 패턴
    "exclude": [], // 제외할 glob 패턴
    "attachments": "attachments", // 이미지 다운로드 폴더
  },
}
```

`.im-nobsidian-ignore` 파일 (`.gitignore`와 동일한 문법)로 동기화 대상에서 제외할 수 있습니다.

## 데이터베이스 모드

페이지 트리 대신 Notion **데이터베이스**에 동기화할 수 있습니다. 각 마크다운 파일이 데이터베이스 행이 되고, 프론트매터가 데이터베이스 속성에 매핑됩니다:

```yaml
---
status: In Progress # → Select 속성
tags: [ai, project] # → Multi-select 속성
priority: 1 # → Number 속성
due: 2026-06-30 # → Date 속성
---
```

## 패키지

| 패키지                                              | 설명                                 | npm                                                                                                         |
| --------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| [`@im-nobsidian/core`](packages/core)               | 동기화 엔진 — 변환, 상태, 충돌 해결  | [![npm](https://img.shields.io/npm/v/@im-nobsidian/core)](https://www.npmjs.com/package/@im-nobsidian/core) |
| [`im-nobsidian`](packages/cli)                      | CLI 도구 (`nobsi` 명령어)            | [![npm](https://img.shields.io/npm/v/im-nobsidian)](https://www.npmjs.com/package/im-nobsidian)             |
| [`obsidian-im-nobsidian`](packages/obsidian-plugin) | Obsidian 플러그인 (사이드바 + DB 뷰) | v0.3.2 (BRAT 설치 가능)                                                                                     |

### 라이브러리로 사용하기

```typescript
import {
  SyncOrchestrator,
  ConfigManager,
  StateDB,
  NotionClient,
  NodeVaultFS,
} from "@im-nobsidian/core";

const config = await new ConfigManager("/path/to/vault").load();
const stateDb = StateDB.open("/path/to/vault/.im-nobsidian/sync.db");
const client = new NotionClient({ token: config.notion.token });
const vaultFs = new NodeVaultFS("/path/to/vault", config.paths);

const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);
await orchestrator.sync({ dryRun: false });
```

## 알려진 제한사항

동기화는 **무손실·멱등·수렴**입니다. 내용은 사라지지 않고, 바뀐 게 없는 볼트를 다시 동기화하면
변경이 0건이며, 표기가 바뀌어야 하는 경우에도 **첫 왕복 한 번**에 자리를 잡고 그 뒤로는 움직이지
않습니다. 아래 표는 Notion의 저장 모델이 *표기*를 제약하는 지점을 전부 모은 것으로, 제약이
영구적인지 1회성 정규화인지에 따라 나눴습니다.

### 영구 제한

| 제한                      | 원인                                                            | 대응                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Notion 전용 블록          | API가 버튼/폼/동기 블록에 `unsupported` 반환                    | 콜아웃 플레이스홀더로 보존                                                                                                                                                                                   |
| Rate limit                | Notion 공식 제한 3 req/s                                        | 내장 레이트 리미터 + 지수 백오프                                                                                                                                                                             |
| Soft break 블록 분리      | 단일 개행이 Notion에서 별도 문단 블록이 됨                      | 의도적 분리는 빈 줄(문단 구분)로 작성                                                                                                                                                                        |
| 연속 빈 문단 압축         | "빈 문단 N개" 개념이 Notion에 없어 1개로 정규화                 | 의미적 차이 없음 — pull 시 블록 간격은 복원됨                                                                                                                                                                |
| 노트 임베드 (`![[노트]]`) | Notion에 노트 트랜스클루전 개념이 없고, 커스텀 스킴 링크는 버림 | **원문 그대로 텍스트로 보존** — 동기화 후에도 옵시디언에서 임베드로 렌더링                                                                                                                                   |
| 첫 Push 위키링크          | 신규 페이지 간 상호 참조가 첫 동기화 시 미해결 가능             | 다음 동기화에서 자동 해결                                                                                                                                                                                    |
| 볼트 밖 페이지 링크       | 대상이 인테그레이션에 공유되지 않았거나 pull 대상이 아님        | 끊긴 위키링크 대신 **클릭 가능한 `https://www.notion.so/…` 링크**로 유지 — 페이지 id 가 살아 있어 그 페이지가 볼트에 들어오면 정식 위키링크가 됨. 각주 앵커(`#<blockId>`)도 살려서 해당 블록으로 정확히 이동 |

### 1회성 정규화

*쓰는 방식*이 첫 왕복에서 한 번 바뀌고, 그 뒤로는 고정됩니다(이후 `nobsi status` 변경 0건).
내용이 사라지는 게 아니라, Notion이 실제로 저장할 수 있는 표기로 자리를 잡는 것입니다.

| 이렇게 쓰면                              | 첫 왕복 뒤                                  | 이유                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `\[이스케이프\]`                         | `[이스케이프]`                              | Notion은 마크다운 이스케이프가 아니라 평문을 저장하므로 백슬래시가 저장/내보내기를 통과하지 못합니다. 그래서 `\[\[노트\]\]` 는 진짜 위키링크가 됩니다 — 이스케이프로 위키링크를 숨길 수는 없습니다. |
| `%%im-nobsidian:toggle:start%%` … `:end` | `> [!toggle]- 제목`                         | Notion이 토글을 `<details>` 로 돌려주고, 이는 옵시디언 콜아웃 형태로 매핑됩니다. 마커 형태는 레거시 입력으로 계속 받습니다.                                                                         |
| 컬럼 _N_ 개짜리 컬럼 레이아웃            | 컬럼마다 `%%im-nobsidian:column%%` 마커 1개 | 마커가 두 컬럼을 나누는 구분자가 아니라 컬럼을 여는 표시라서, 첫 컬럼에도 하나 붙습니다.                                                                                                            |

펜스/인라인 코드 안의 이스케이프는 건드리지 않고, `\\[`(백슬래시 자체를 이스케이프한 것)도 그대로
둡니다 — 진짜 `\[` 만 정규화됩니다.

## 로드맵

```
v0.3.2 ✅ 렌더 충실도(토글/표/콜아웃/코드펜스 — 결함 15종 + 본문 삼킴 코드펜스 봉합),
        동기화 견고성(pull 정지, 네트워크 시간상한, Retry-After, 링크 4종,
        CLI 종료코드), 삭제된 DB 행 복원,
        clean-slate 1268노트 실데이터 E2E(churn-0, 렌더 결함 0), 1662개 테스트
v0.3.1 ✅ steady-churn 근절(동명 인라인 DB 폴더 분리, linked view 컨테이너
        중복 제거), 옵시디언/HTML 주석 왕복, 페이지 멘션 URL 수정,
        clean-slate 887파일 실데이터 E2E(churn-0, 무손실), 1285개 테스트
v0.3.0 ✅ 왕복 충실도 일괄 봉합(주석/각주/하이라이트/표정렬/블록간격),
        증분 pull 누락 수정, --force 전체 스캔, Node 22+
v0.2.1  --version 동적 읽기 수정, 문서 현행화, 1038개 테스트
v0.2.0  100% 무손실·멱등·수렴, 불변식 안전망, npm 배포
v0.1.12 Pull 충실도 + 동기화 안정성, 중첩 DB→Bases, 갤러리 커버, 777개 테스트
v1.0.0  → 커뮤니티 등록, 멀티 워크스페이스, 1000+ 노트
```

전체 계획은 [ROADMAP.md](docs/06-devlog/ROADMAP.md)를 참고하세요.

## 개발

```bash
git clone https://github.com/JaylenAI/Im-Nobsidian.git
cd Im-Nobsidian
pnpm install
pnpm build
pnpm test          # 1662개 테스트
pnpm lint
pnpm typecheck
```

### 프로젝트 구조

```
packages/
├── core/              # @im-nobsidian/core — 동기화 엔진
│   ├── src/
│   │   ├── converter/     # Markdown ↔ Notion 변환 파이프라인
│   │   ├── notion/        # Notion API 클라이언트 + 속성 매퍼
│   │   ├── state/         # SQLite 상태 데이터베이스
│   │   ├── sync/          # 오케스트레이터, 변경 감지, 볼트 FS
│   │   ├── view/          # DB 뷰 렌더링 + Bases .base 파일 생성기
│   │   └── utils/         # 해시, 로거, 파일명 정제
│   └── tests/
├── cli/               # im-nobsidian CLI (nobsi 명령어)
└── obsidian-plugin/   # Obsidian 플러그인 (사이드바 + DB 뷰)
    └── src/views/         # Svelte 5 컴포넌트 (Gallery/Board/Table/Calendar/List/Timeline + 사이드바)
```

## 기여

기여를 환영합니다! 개발 환경 설정, 코드 스타일, PR 프로세스는 [기여 가이드](CONTRIBUTING.md)를 참고하세요.

```bash
git clone https://github.com/JaylenAI/Im-Nobsidian.git
cd Im-Nobsidian
pnpm install && pnpm build && pnpm test
```

## 보안

취약점 보고는 [보안 정책](SECURITY.md)을 참고하세요.

## 라이선스

[MIT](LICENSE) — built by [@JaylenAI](https://github.com/JaylenAI).
