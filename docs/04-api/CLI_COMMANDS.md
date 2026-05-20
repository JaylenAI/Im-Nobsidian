# CLI Commands / 명령어 레퍼런스

모든 명령어는 Obsidian 볼트 디렉토리에서 실행합니다.

## Global Options / 글로벌 옵션

| 옵션        | 설명           |
| ----------- | -------------- |
| `--verbose` | 상세 로그 출력 |
| `--quiet`   | 최소 출력      |
| `--version` | 버전 표시      |
| `--help`    | 도움말 표시    |

---

## nobsi init

Notion 연결을 설정하고 `.im-nobsidian/config.json`을 생성합니다.

```bash
nobsi init                                    # 대화형 설정
nobsi init --token ntn_xxx --root-page-id abc  # 비대화형
nobsi init --non-interactive                   # CI/스크립트용
```

| 옵션                  | 설명                      |
| --------------------- | ------------------------- |
| `--token <token>`     | Notion Integration Secret |
| `--root-page-id <id>` | 루트 페이지/DB ID         |
| `--non-interactive`   | 대화형 프롬프트 비활성화  |

---

## nobsi push

로컬 변경사항을 Notion에 업로드합니다.

```bash
nobsi push              # 모든 변경 파일 Push
nobsi push --dry-run    # 미리보기 (실제 변경 없음)
nobsi push --force      # 충돌 무시하고 강제 Push
nobsi push --path "notes/plan.md"  # 특정 파일만
```

| 옵션            | 설명                  |
| --------------- | --------------------- |
| `--dry-run`     | 예정 작업만 표시      |
| `--force`       | 충돌 파일도 강제 Push |
| `--path <path>` | 특정 파일/폴더만 Push |

---

## nobsi pull

Notion 변경사항을 로컬에 다운로드합니다.

```bash
nobsi pull              # 모든 변경 Pull
nobsi pull --dry-run    # 미리보기
```

| 옵션        | 설명             |
| ----------- | ---------------- |
| `--dry-run` | 예정 작업만 표시 |

---

## nobsi sync

양방향 동기화를 실행합니다 (Pull → Push 순서).

```bash
nobsi sync              # 양방향 동기화
nobsi sync --dry-run    # 미리보기
```

| 옵션        | 설명             |
| ----------- | ---------------- |
| `--dry-run` | 예정 작업만 표시 |

---

## nobsi status

현재 동기화 상태를 표시합니다.

```bash
nobsi status
```

출력 예시:

```
  Sync Status
  ──────────────────────────────────────────────────
  Root page:  35a13b18...
  Direction:  bidirectional
  Last sync:  2026-05-19 23:45:12

  Tracked files: 42
  ● synced     38
  ● modified   2
  ● new        1
  ● conflict   1

  Modified files:
    ~ Project Proposal.md       (local changed)
    ~ Dev Notes/API Guide.md    (local changed)

  New files:
    + Meeting Notes/2026-05-20.md (untracked)

  Conflicts:
    ! README.md                 (both sides changed)

  Run nobsi resolve to resolve conflicts
  Run nobsi sync to push/pull changes
```

---

## nobsi diff

로컬과 Notion 간 차이를 상세하게 표시합니다.

```bash
nobsi diff              # 전체 diff
nobsi diff notes/plan.md  # 특정 파일 diff
```

---

## nobsi resolve

충돌 파일을 해결합니다.

```bash
nobsi resolve                            # 대화형 해결
nobsi resolve --strategy local-wins      # 로컬 우선 (전체)
nobsi resolve --strategy remote-wins     # Notion 우선 (전체)
```

| 옵션                    | 설명                         |
| ----------------------- | ---------------------------- |
| `--strategy <strategy>` | `local-wins` / `remote-wins` |

---

## nobsi watch

파일 변경을 감시하고 자동으로 동기화합니다.

```bash
nobsi watch
```

파일 변경 감지 시 자동으로 Push가 실행됩니다. `Ctrl+C`로 종료합니다.

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
nobsi sync --dry-run    # 변경사항 확인
nobsi sync              # 실제 동기화
```

### 특정 폴더만 동기화

```bash
nobsi push --path "projects/"
```
