# CLI Commands / 명령어 레퍼런스

`nobsi`(별칭 `im-nobsidian`)의 전체 명령어와 옵션. 모든 명령어는 **Obsidian 볼트 디렉토리에서** 실행하며, `.im-nobsidian/config.json`을 자동으로 읽습니다.

> 소스 기준: `packages/cli/src/commands/*.ts` (v0.3.x)

## Global Options / 글로벌 옵션

프로그램 레벨 옵션 — 모든 하위 명령 앞에 붙일 수 있습니다.

| 옵션        | 설명           |
| ----------- | -------------- |
| `--verbose` | 상세 로그 출력 |
| `--quiet`   | 최소 출력      |
| `--version` | 버전 표시      |
| `--help`    | 도움말 표시    |

> `--dry-run`은 글로벌 옵션이 **아닙니다** — `push`·`pull`·`sync`에만 존재합니다.

## 명령어 한눈에 보기

| 명령어          | 방향/역할               | 주요 옵션                                      | Notion API 호출 |
| --------------- | ----------------------- | ---------------------------------------------- | :-------------: |
| `nobsi init`    | 초기 설정               | `--token` `--root-page-id` `--non-interactive` |    검증 1회     |
| `nobsi push`    | Obsidian → Notion       | `--dry-run` `--path`                           |        O        |
| `nobsi pull`    | Notion → Obsidian       | `--dry-run` `--path` `--force`                 |        O        |
| `nobsi sync`    | 양방향 (pull → push)    | `--dry-run`                                    |        O        |
| `nobsi status`  | 동기화 상태             | `--full`                                       | `--full`일 때만 |
| `nobsi diff`    | 로컬 변경 diff          | `[path]` `--color`                             |   X (로컬만)    |
| `nobsi fetch`   | 원격 스캔 (삭제 감지)   | —                                              |        O        |
| `nobsi resolve` | 충돌 해결               | `--strategy`                                   |        O        |
| `nobsi watch`   | 변경 감시 + 자동 동기화 | `--debounce` `--interval`                      |        O        |

---

## nobsi init

Notion 연결을 설정하고 `.im-nobsidian/config.json` + 상태 DB를 생성합니다. 대화형은 접근 가능한 페이지 목록을 보여주고 루트를 고르게 합니다.

```bash
nobsi init                                          # 대화형 설정
nobsi init --token ntn_xxx --root-page-id abc123 --non-interactive  # CI/스크립트
```

| 옵션                  | 설명                                        |
| --------------------- | ------------------------------------------- |
| `--token <token>`     | Notion Integration Secret (`ntn_`으로 시작) |
| `--root-page-id <id>` | 루트 페이지/DB ID                           |
| `--non-interactive`   | 대화형 프롬프트 비활성화 (위 두 옵션 필수)  |

---

## nobsi push

로컬 `.md` 변경사항을 Notion에 반영합니다. SHA-256 해시로 변경 파일만 골라 올립니다.

```bash
nobsi push                          # 변경된 모든 파일 push
nobsi push --dry-run                # 미리보기 (실제 변경 없음)
nobsi push --path "notes/plan.md"   # 특정 파일/폴더만
nobsi push -p "projects/" -p "log/" # 여러 경로 지정
```

| 옵션                    | 설명                              |
| ----------------------- | --------------------------------- |
| `--dry-run`             | 예정 작업만 표시                  |
| `-p, --path <paths...>` | 특정 파일/폴더만 push (복수 가능) |

---

## nobsi pull

Notion 변경사항을 로컬에 반영합니다. `last_edited_time` 증분 감지로 바뀐 페이지만 내려받습니다.

```bash
nobsi pull                          # 변경된 모든 페이지 pull
nobsi pull --dry-run                # 미리보기
nobsi pull --path "projects/"       # 특정 경로만
nobsi pull --force                  # 증분 감지 건너뛰고 전체 스캔
```

| 옵션                    | 설명                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `--dry-run`             | 예정 작업만 표시                                                                                 |
| `-p, --path <paths...>` | 특정 경로만 pull (복수 가능)                                                                     |
| `--force`               | 증분 감지를 건너뛰고 전체 스캔. Notion search 인덱싱 지연으로 누락된 신규 페이지·child DB 복구용 |

---

## nobsi sync

양방향 동기화를 실행합니다 — **Pull 먼저, 그다음 Push** 순서.

```bash
nobsi sync              # 양방향 동기화
nobsi sync --dry-run    # 미리보기
```

| 옵션        | 설명             |
| ----------- | ---------------- |
| `--dry-run` | 예정 작업만 표시 |

---

## nobsi status

동기화 상태를 표시합니다. 기본은 **로컬만** 확인(빠름), `--full`은 Notion 원격 변경까지 확인(API 호출, 느림).

```bash
nobsi status            # 로컬 변경만 (오프라인, 빠름)
nobsi status --full     # Notion 원격 변경까지 양방향 확인
```

| 옵션     | 설명                                    |
| -------- | --------------------------------------- |
| `--full` | Notion 원격 변경까지 양방향 확인 (느림) |

출력 예시:

```
  Sync Status
  ──────────────────────────────────────────────────
  Root page:  35a13b18...
  Direction:  bidirectional
  Last sync:  2026-07-17 23:45:12

  Tracked files: 887
  ● synced     886
  ● modified   1
  ● new        1

  Modified files:
    ~ Project Proposal.md       (local changed)

  New files:
    + Meeting Notes/2026-07-20.md (untracked)

  Run nobsi sync to push/pull changes
  Run nobsi status --full to check Notion remote changes
```

---

## nobsi diff

로컬 파일의 변경 내용을 diff로 표시합니다. **로컬 스냅샷 기준**(Notion API 미호출)이라 빠릅니다.

```bash
nobsi diff                  # 변경된 모든 파일
nobsi diff notes/plan.md    # 특정 파일만
nobsi diff --no-color       # 컬러 없이
```

| 인자/옵션 | 설명                                      |
| --------- | ----------------------------------------- |
| `[path]`  | 특정 파일 경로 (생략 시 변경된 모든 파일) |
| `--color` | 컬러 출력 (기본 켜짐, `--no-color`로 끔)  |

---

## nobsi fetch

Notion 원격 상태만 스캔해 신규/수정/**삭제** 페이지 수를 보고합니다. 실제 파일은 건드리지 않습니다 — `pull` 전에 원격 변경 규모를 미리 파악할 때 씁니다.

```bash
nobsi fetch
```

출력 예시:

```
  Remote Scan
  ────────────────────────────────────────
  + New pages:      3
  ~ Modified pages: 12
  - Deleted pages:  1

  Run nobsi pull to apply remote changes
```

---

## nobsi resolve

충돌(양쪽 동시 변경) 파일을 해결합니다. `--strategy` 없이 실행하면 파일별 대화형으로, 지정하면 일괄 해결합니다.

```bash
nobsi resolve                            # 대화형 (파일별 선택)
nobsi resolve --strategy local-first     # 로컬 우선 (일괄)
nobsi resolve --strategy remote-first    # Notion 우선 (일괄)
nobsi resolve --strategy duplicate       # 양쪽 보존 (.conflict 파일 생성)
```

| 옵션                        | 설명                                                   |
| --------------------------- | ------------------------------------------------------ |
| `-s, --strategy <strategy>` | `local-first` / `remote-first` / `duplicate` 일괄 전략 |

대화형 선택지: **로컬 유지** / **원격 유지** / **자동 병합(3-way)** / **복제(.conflict)**.

---

## nobsi watch

파일 변경을 감시해 자동으로 동기화합니다. `Ctrl+C`로 종료. 파일 저장 시 debounce 후 push, `--interval` 지정 시 주기적 양방향 sync도 수행합니다.

```bash
nobsi watch                       # 기본 (debounce 2초, 주기 sync 없음)
nobsi watch --debounce 5000       # 저장 후 5초 대기 뒤 동기화
nobsi watch --interval 300        # 300초마다 주기적 양방향 sync
```

| 옵션                       | 설명                                    |
| -------------------------- | --------------------------------------- |
| `-d, --debounce <ms>`      | 변경 감지 후 대기(ms), 기본 `2000`      |
| `-i, --interval <seconds>` | 주기적 풀 동기화 간격(초), 기본 `0`(끔) |

---

## Examples / 사용 예시

### 첫 동기화

```bash
cd ~/my-vault
nobsi init
nobsi sync
```

### CI/CD 파이프라인

```bash
nobsi init --token $NOTION_TOKEN --root-page-id $ROOT_ID --non-interactive
nobsi pull --dry-run    # 원격 변경 미리보기
nobsi sync              # 실제 동기화
```

### 특정 폴더만 동기화

```bash
nobsi push --path "projects/"
nobsi pull --path "projects/"
```

### 신규 페이지가 안 보일 때 (search 인덱싱 지연)

```bash
nobsi pull --force      # 증분 감지 우회, 전체 재스캔
```
