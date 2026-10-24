# Obsidian 커뮤니티 플러그인 제출

> 작성일: 2026-05-08 · 마지막 업데이트: 2026-10-24 (v0.9.0)
> 상태: 제출 준비 끝 — 제출은 저장소 주인이 포털에서 한다

## 제출 방식이 바뀌었다 (2026-05-12)

`obsidianmd/obsidian-releases` 에 `community-plugins.json` 줄을 더하는 PR 은 더 쓰지 않는다. Obsidian 이 웹 포털
**community.obsidian.md** 와 자동 검사로 바꿨다([공지](https://obsidian.md/blog/future-of-plugins/) ·
[문서](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)).

- 포털에 Obsidian 계정으로 들어가 GitHub 계정을 잇고(저장소 주인 확인), 저장소를 고른다
- 자동 검사가 몇 분 안에 돌고, 고칠 것을 포털이 보인다. 고치려면 저장소를 고치고 **버전을 올린 새 릴리스**를 낸다
- 통과하면 24시간 안에 앱의 커뮤니티 플러그인 목록에 뜬다
- 검사는 처음 한 번이 아니라 **새 버전마다** 돈다(보안 · 코드 품질 · 알려진 취약점 · 악성 추가)
- 포털에서 브랜치 · 태그 · 커밋을 미리 검사(preview scan)할 수 있다

## 준비 상태

| 요건                                                                | 상태   | 근거                                                                                        |
| ------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| 루트 `README.md` (영어) · `LICENSE` · `manifest.json`               | ✅     | 루트에 셋 다 있다(ADR-032). LICENSE 는 MIT                                                  |
| `id` 에 `obsidian` 이 없고 겹치지 않음                              | ✅     | `im-notion-sync`                                                                            |
| 설명에 브랜드 이름 없음 · 마침표로 끝남                             | ✅     | 디렉터리 검사(`obsidian-review.yml`)가 push 마다 본다                                       |
| 릴리스 태그 == manifest 버전(`v` 없이) · 자산 `main.js` 등 셋       | ✅     | GitHub 릴리스 `0.9.0` — `main.js` · `manifest.json` · `styles.css`                          |
| `versions.json` 에 이 버전의 `minAppVersion`                        | ✅     | `0.9.0` → `1.12.4`                                                                          |
| README 공개 항목(계정 · 네트워크 · 파일 · 텔레메트리 · 광고 · 결제) | ✅ dev | README 「Privacy and Network Use」. 🔴 디렉터리는 기본 브랜치(main) README 를 읽는다 — 아래 |
| 결제 분류                                                           | —      | 포털에서 **Free** 로 고른다                                                                 |
| `isDesktopOnly: true`                                               | ✅     | Node 파일 API 로 상태 DB 를 쓴다. lookbehind 정규식 규칙도 이 값으로 건너뛴다               |

### 🔴 README 를 main 에 올려야 한다

공개 항목은 dev 에만 있다(v0.9.0 릴리스 뒤에 더함). 저장소의 기본 브랜치가 main 이라 제출 전에 main 에 있어야 한다.
다음 릴리스에 함께 나가거나, 문서만 담은 패치 릴리스(v0.9.1)로 낸다.

## 자동 검사를 미리 돌린 결과 (2026-10-24, dev)

포털과 같은 규칙을 쓰는 `obsidianmd/obsidian-workflows`(2026-09-22 커밋)를 로컬에서 `scanner-lint: true` ·
`strict: true` 로 돌렸다. 형식 정보가 있어야 하는 규칙을 켜려고 임시 루트 `tsconfig.json`(패키지 셋을 참조)을 두고
돌린 뒤 지웠다(ADR-032).

- **오류 0** · 경고 826 · PR 범위 검사 모두 통과
- 경고의 대부분은 CLI(형식 안전성 · 규칙 메시지)와 core 다. 디렉터리가 보는 것은 플러그인이다
- 플러그인 경고
  - ADR-032 가 남긴 넷: `setWarning` 낡음 · `getSettingDefinitions` 없음 · `Vault.trash` · `createSpan`
  - `PluginSettingTab.display` 낡음(1.13.0) 셋 — `getSettingDefinitions` 와 같은 일이다. minAppVersion 1.12.4 에는
    대체 API 가 없다
- `readme-name-mismatch` 경고는 README 첫 `# ` 줄로 코드 블록 속 셸 주석을 읽어서 났다. 주석을 글로 옮겨 없앴다
- `eslint-plugin-obsidianmd` 0.4.2 를 플러그인 소스에 따로 돌리면 `ui/sentence-case` 경고 7 이 더 난다. 「Notion
  DB」 · 「Im-Notion Sync」 · URL 예시를 소문자로 바꾸라는 것이라 두었다

검사 오류로 막는 규칙(`no-eval` · `no-implied-eval` · `no-unsanitized` · `regex-lookbehind` · `no-forbidden-elements`)은
하나도 걸리지 않았다.

## 제출 순서 (저장소 주인)

1. README 공개 항목이 main 에 있는지 본다(위)
2. community.obsidian.md 에 Obsidian 계정으로 들어가 GitHub 계정(`JaylenAI`)을 잇는다
3. 저장소 `JaylenAI/Im-Nobsidian` 를 고르고 결제 분류 **Free** 로 낸다
4. 자동 검사 결과를 본다. 고칠 것이 나오면 고치고 버전을 올려 릴리스한다(`RELEASE_PROCESS.md`)

## 남은 것

- GitHub 저장소 설명이 「Obsidian plugin in development」 로 남아 있다 — 저장소 설정에서 고친다
- 포털이 앞으로 접근 권한(네트워크 · 파일 시스템 · 클립보드) 선언을 받는다고 했다. 생기면 README 공개 항목과 맞춰 적는다
