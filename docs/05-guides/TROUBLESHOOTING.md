# Troubleshooting / 문제 해결 가이드

## 자주 발생하는 문제

### "Notion API 인증 실패"

```
Error: Could not find integration. Make sure the provided token is correct.
```

**원인**: 잘못된 토큰 또는 만료된 토큰

**해결**:

1. [notion.so/my-integrations](https://www.notion.so/my-integrations)에서 토큰 재확인
2. 토큰이 `ntn_`로 시작하는지 확인
3. `nobsi init`으로 재설정

### "페이지를 찾을 수 없음"

```
Error: Could not find page with ID: abc123...
```

**원인**: 페이지에 통합이 연결되지 않음

**해결**:

1. Notion에서 해당 페이지 열기
2. 우상단 `···` → **Connections** → 통합 추가
3. 하위 페이지에도 자동으로 접근 권한이 부여됨

### "설정 파일 검증 실패"

```
Error: 설정 파일 검증 실패: invalid_type, expected object...
```

**원인**: `config.json`에 필수 섹션 누락

**해결**: `.im-nobsidian/config.json`에 모든 필수 섹션이 있는지 확인합니다:

```jsonc
{
  "version": 1,
  "notion": { "token": "...", "rootPageId": "...", "parentMode": "page" },
  "sync": {
    "direction": "both",
    "conflictStrategy": "manual",
    "autoSync": false,
    "autoSyncInterval": 300,
    "deleteSync": false,
  },
  "paths": { "include": ["**/*"], "exclude": [], "attachments": "attachments" },
  "conversion": {
    "preferMarkdownApi": true,
    "preserveMarkers": true,
    "frontmatterMapping": true,
    "imageDownload": "immediate",
  },
  "advanced": { "concurrency": 3, "maxRetries": 5, "timeoutMs": 30000, "batchSize": 100 },
}
```

가장 간단한 방법: `nobsi init`을 다시 실행하면 올바른 설정이 자동 생성됩니다.

### "Rate limit 초과"

```
Error: Rate limited - too many requests
```

**원인**: Notion API는 3 req/s 제한이 있습니다

**해결**: 자동으로 재시도됩니다 (지수 백오프 + 지터). 대규모 볼트에서는 시간이 걸릴 수 있습니다.
`advanced.concurrency`를 낮추면 더 안정적입니다:

```jsonc
{ "advanced": { "concurrency": 2 } }
```

### "타임아웃"

```
Error: notionhq_client_request_timeout
```

**원인**: 대규모 페이지나 네트워크 불안정

**해결**: `advanced.timeoutMs`를 높이세요:

```jsonc
{ "advanced": { "timeoutMs": 60000 } }
```

### "이미지가 Notion에 표시되지 않음"

**원인**: Notion API 제한으로 페이지 본문에 로컬 이미지를 직접 업로드할 수 없습니다.

**현재 동작**: Push 시 이미지는 텍스트 플레이스홀더로 변환됩니다.
Pull 시 Notion의 이미지는 로컬에 정상 다운로드됩니다.

### "위키링크가 첫 Push 시 일반 텍스트로 변환됨"

**원인**: 아직 Notion에 존재하지 않는 페이지에 대한 위키링크는 해결할 수 없습니다.

**해결**: 두 번째 동기화(`nobsi sync`)를 실행하면 자동으로 해결됩니다.
첫 Push에서 페이지가 생성되고, 이후 동기화에서 위키링크가 페이지 멘션으로 매핑됩니다.

### "빈 줄이 사라짐"

**원인**: Notion Markdown API가 빈 줄을 정규화합니다.

**영향**: 렌더링 결과는 동일합니다 (Obsidian에서 미리보기 시 차이 없음).
이는 Notion 측 동작이므로 해결할 수 없습니다.

### "`\[대괄호\]` 의 백슬래시가 사라짐"

**원인**: Notion은 마크다운 이스케이프를 저장하지 않습니다. `\[x\]` 는 Notion에 평문 `[x]` 로
들어가고, 내보낼 때 다시 이스케이프가 붙었다 풀리므로 백슬래시가 왕복을 통과할 수 없습니다.

**영향**: 첫 왕복에서 `\[x\]` → `[x]` 로 **한 번** 바뀌고 그 뒤로는 고정됩니다(내용 손실 없음,
이후 변경 0건). 다만 `\[\[노트\]\]` 는 `[[노트]]` 가 되어 **진짜 위키링크로 취급**되므로,
이스케이프로 위키링크를 숨기는 용도로는 쓸 수 없습니다.

**건드리지 않는 경우**: 펜스/인라인 코드 블록 안, 그리고 `\\[` 처럼 백슬래시 자신이 이스케이프된
경우는 원문 그대로 둡니다.

### "토글·컬럼 마커 표기가 첫 동기화에서 바뀜"

**원인**: 두 블록 모두 Notion이 돌려주는 정준형에 맞춰 표기가 한 번 정리됩니다.

| 쓴 형태                                  | 첫 왕복 뒤                                  |
| ---------------------------------------- | ------------------------------------------- |
| `%%im-nobsidian:toggle:start%%` … `:end` | `> [!toggle]- 제목` (옵시디언 콜아웃)       |
| 컬럼 N개짜리 레이아웃                    | 컬럼마다 `%%im-nobsidian:column%%` 마커 1개 |

**영향**: 1회성이며 내용 손실이 없습니다. 마커형 토글도 입력으로는 계속 받습니다.

### "`![[노트]]` 임베드가 Notion에서 링크가 아니라 글자로 보임"

**원인**: Notion에는 노트 트랜스클루전 개념이 없고, 커스텀 스킴 링크는 저장 시 버려집니다.

**현재 동작**: 임베드 문법을 **원문 그대로 텍스트로 보존**합니다. Notion 화면에서는 글자로
보이지만, 동기화를 왕복해도 옵시디언에서는 그대로 임베드로 렌더링됩니다. (예전에는 페이지
링크로 바꿔 올렸는데, Notion이 그 링크를 버려서 평문으로 영구 붕괴했습니다.)

### "새로 만든 페이지·DB가 pull 후에도 안 보임"

**원인**: Notion search 인덱스 반영 지연으로 증분 스캔이 신규 페이지·DB를 놓칠 수 있습니다.

**해결**: 증분을 우회하고 전체를 다시 스캔합니다:

```bash
nobsi pull --force
```

### "충돌 발생"

```
⚠️  Conflicts: 1 file
  meeting.md (both sides modified)
```

**원인**: Obsidian과 Notion 양쪽에서 같은 파일을 수정함

**해결**:

```bash
nobsi resolve                        # 대화형 (파일별 선택)
nobsi resolve --strategy local-first  # 항상 로컬 우선
nobsi resolve --strategy remote-first # 항상 Notion 우선
```

또는 `config.json`에서 기본 전략을 설정합니다:

```jsonc
{ "sync": { "conflictStrategy": "local-first" } }
```

## 데이터 안전

- Im-Nobsidian은 **절대로 데이터를 자동 삭제하지 않습니다** (`deleteSync: false` 기본값)
- 충돌 시 **양쪽 버전을 모두 보존**합니다
- `push`·`pull`·`sync` 는 `--dry-run`으로 **미리 확인**할 수 있습니다
- 상태 DB (`.im-nobsidian/sync.db`)를 삭제하면 전체 재동기화됩니다

## 지원 및 문의

- GitHub Issues: [github.com/JaylenAI/Im-Nobsidian/issues](https://github.com/JaylenAI/Im-Nobsidian/issues)
- Security: [SECURITY.md](../../SECURITY.md)
