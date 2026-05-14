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
  "advanced": { "concurrency": 3, "maxRetries": 5, "timeoutMs": 30000, "batchSize": 50 },
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

### "충돌 발생"

```
⚠️  Conflicts: 1 file
  meeting.md (both sides modified)
```

**원인**: Obsidian과 Notion 양쪽에서 같은 파일을 수정함

**해결**:

```bash
nobsi resolve                        # 대화형 (파일별 선택)
nobsi resolve --strategy local-wins  # 항상 로컬 우선
nobsi resolve --strategy remote-wins # 항상 Notion 우선
```

또는 `config.json`에서 기본 전략을 설정합니다:

```jsonc
{ "sync": { "conflictStrategy": "local-wins" } }
```

## 데이터 안전

- Im-Nobsidian은 **절대로 데이터를 자동 삭제하지 않습니다** (`deleteSync: false` 기본값)
- 충돌 시 **양쪽 버전을 모두 보존**합니다
- `--dry-run`으로 **항상 미리 확인**할 수 있습니다
- 상태 DB (`.im-nobsidian/sync.db`)를 삭제하면 전체 재동기화됩니다

## 지원 및 문의

- GitHub Issues: [github.com/JaylenAI/Im-Nobsidian/issues](https://github.com/JaylenAI/Im-Nobsidian/issues)
- Security: [SECURITY.md](../../SECURITY.md)
