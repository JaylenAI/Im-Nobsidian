# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1.0 | ❌        |

## Reporting a Vulnerability

보안 취약점을 발견하셨다면 **공개 이슈 대신 비공개로 보고**해주세요.

### 보고 방법

1. GitHub의 [Security Advisories](https://github.com/JaylenAI/Im-Nobsidian/security/advisories/new)를 통해 보고
2. 또는 이메일: jaylenhanai@gmail.com

### 포함할 정보

- 취약점 설명
- 재현 단계
- 영향 범위
- 가능하다면 수정 제안

### 응답 시간

- 확인: 48시간 이내
- 초기 평가: 7일 이내
- 수정 릴리스: 심각도에 따라 결정

## Security Practices

- Notion API 토큰은 로컬 `.env` 파일에만 저장되며 절대 커밋되지 않습니다
- 동기화 상태 DB는 로컬 `.im-nobsidian/sync.db`에 저장됩니다
- 모든 API 통신은 Notion 공식 SDK를 통한 HTTPS로 이루어집니다
- Rate limiting으로 API 남용을 방지합니다
