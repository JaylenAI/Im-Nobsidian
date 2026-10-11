# ADR-032: 배포 파일은 레포 루트에 두고 디렉터리 검사를 CI 에서 돌린다

> 상태: 승인
> 결정일: 2026-10-11

## 맥락

플러그인은 커뮤니티 디렉터리 · BRAT · 수동 설치로 퍼진다. 셋 다 레포 «루트» 의 `manifest.json` 과 릴리스의 세
파일을 본다(U-05). 이 레포의 연구 문서도 그렇게 적었다(`docs/01-research/OBSIDIAN_API_RESEARCH.md`).

- `manifest.json` · `versions.json` 이 `packages/obsidian-plugin/` 에만 있었다. 루트에는 없었다.
- Obsidian 은 `releases/download/<manifest 버전>/` 에서 받는다. 이 레포의 태그는 `vX.Y.Z` 라 그 주소가 없다.
- 디렉터리 검사(`obsidianmd/obsidian-workflows` v1.2.3)를 dev 에 돌리니 manifest 가 오류로 떨어졌다.
  - 설명에 브랜드 이름(`Obsidian`)이 있다 — 오류
  - 설명이 마침표로 끝나지 않는다 — 경고
  - `fundingUrl` 이 후원 페이지가 아니라 레포다
- 같은 검사의 스캐너 lint(eslint-plugin-obsidianmd)는 플러그인 코드에서 오류 5건 · 경고 38건을 냈다
  (형식 정보를 준 실행). core 79건 · CLI 632건은 경고다.

## 결정

1. **`manifest.json` · `versions.json` 의 원본은 루트다.** `git mv` 로 옮겼다. 빌드(`esbuild.config.mjs`)가
   루트 manifest 를 플러그인 폴더에 옮겨 두고, 그 사본은 git 에 넣지 않는다(`.gitignore`).
   - 설명: `Sync notes, databases, and attachments between your vault and Notion in both directions.`
   - `fundingUrl` 을 뺐다. 후원 페이지가 생기면 넣는다.
2. **GitHub 릴리스는 맨 버전 태그(`X.Y.Z`)에 만든다.** `release.yml` 은 `vX.Y.Z` 푸시로 돈다. 같은 커밋에
   `X.Y.Z` 태그로 릴리스를 만들고 세 파일을 올린다. 그 전에 세 가지를 확인하고, 하나라도 틀리면 npm 발행도 하지
   않는다.
   - 세 파일이 있고 비어 있지 않다
   - 루트 manifest 버전이 태그(`v` 를 뗀 것)와 같다
   - `versions.json[버전]` 이 manifest 의 `minAppVersion` 과 같다
3. **디렉터리 검사를 CI 에서 돌린다**(`.github/workflows/obsidian-review.yml`). dev · main 의 push 와 PR 마다
   manifest · versions.json · README · LICENSE 를 디렉터리와 같은 규칙으로 본다. 빌드와 lint 는 CI 가 이미 하므로
   끈다. 스캐너 lint 는 로컬에서 `scanner-lint: true` 로 돌린다 — 형식 정보가 있어야 하는 규칙이 루트
   `tsconfig.json` 없이 멈춘다(실측).
4. **스캐너 결과는 셋으로 나눈다.**
   - 오류 5건 — 고친다. 셋(설정 폴더를 코드에 적음 · 설명 없는 eslint-disable 둘)은 ADR-031 이 없앴다.
     나머지 둘(`style.display` 대입 · core 의 설명 없는 eslint-disable)과 stylelint 경고(CSS `column-gap`)는
     `fix/plugin-review-lint` 에서 고친다.
   - 플러그인 경고 중 동작이 같은 것(창 타이머 · `globalThis` · 떠 있는 Promise 등)도 같은 브랜치에서 고친다.
   - core · CLI 경고는 고치지 않는다. core 는 Node CLI 와 함께 쓰므로 `window` 를 쓸 수 없고, CLI 는 디렉터리가
     보지 않는다.

## 선택지

| 선택지                                  | 판단                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| 플러그인 폴더에 두고 루트에 복사        | 원본이 둘이다 — 한쪽만 고치면 갈린다                                                        |
| 루트에 두고 플러그인 폴더는 심볼릭 링크 | Windows 체크아웃에서 링크가 글이 된다                                                       |
| **루트가 원본, 빌드가 옮김**            | 원본 하나 · 설치 폴더에 세 파일이 모인다 — **고른 것**                                      |
| 레포 태그를 맨 버전으로 바꿈            | 지금까지의 `v` 태그 · npm 발행 · 릴리스 노트 경로를 모두 바꾼다. 릴리스 때 정한다           |
| **`v` 태그 푸시에 맨 태그 릴리스**      | 지금 흐름을 그대로 두고 Obsidian 이 찾는 주소를 만든다 — **고른 것(릴리스 때 다시 묻는다)** |

## 남은 한계

- 한 커밋에 `vX.Y.Z` · `X.Y.Z` 태그가 둘 생긴다. 둘을 따로 옮기거나 지우면 갈린다.
- 디렉터리 검사의 README 규칙은 «첫 `# ` 줄» 을 제목으로 본다. 루트 README 의 코드 블록 속 셸 주석(`# Set …`)을
  제목으로 읽어 경고를 낸다. README 를 고칠 때 함께 정리한다.
- 저장소 메타데이터 검사는 `GITHUB_TOKEN` 이 있어야 돈다. 로컬 실행에서는 건너뛰었다.
- 번들 사전 점검(인라인 wasm 경고)과 릴리스 검사는 릴리스가 생긴 뒤에야 끝까지 돈다(ADR-031).

## 트레이드오프

- **빌드가 루트 파일을 읽는다.** 플러그인 패키지만 따로 꺼내 빌드하면 manifest 복사가 실패한다. 이 레포는
  워크스페이스로만 빌드한다.
- **CI 가 외부 액션(`obsidianmd/obsidian-workflows@v1`)을 쓴다.** 메이저 태그를 따라가므로 규칙이 늘면 CI 가
  붉어질 수 있다. 디렉터리가 같은 규칙으로 거절하므로 미리 아는 편이 낫다.

## 영향

- 옮김: `packages/obsidian-plugin/{manifest,versions}.json` → 루트
- 추가: `.github/workflows/obsidian-review.yml` · `obsidian-plugin/tests/distribution.test.ts`
- 수정: `.github/workflows/release.yml` · `obsidian-plugin/esbuild.config.mjs` · `.gitignore` ·
  `obsidian-plugin/README.md`(수동 설치는 세 파일, 설정 폴더 이름은 볼트마다 다를 수 있음)
- 플러그인 id(`im-notion-sync`) · 이름 · 버전은 바뀌지 않았다.

## 검증

- `distribution.test.ts` — 빌드가 옮긴 manifest 가 루트와 같다. versions.json 이 지금 버전을 담고 키 · 값이 모두
  `x.y.z` 다. 변이 시험(버전 누락 · 사본이 다름) 모두 잡힘.
- 디렉터리 검사를 로컬에서 돌림(`node dist/index.js`, 엄격 모드)
  - dev: 실패 — 오류 1(브랜드 이름) · 경고 4
  - 이 브랜치 작업트리: 통과 — 오류 0 · 경고 1(README 제목, 위 한계)
- `release.yml` 의 확인 단계를 같은 셸로 돌림
  - dev 에서 `v0.3.2` — 실패(`versions.json[0.3.2]` 1.7.0 ≠ minAppVersion 1.12.4). v0.4.0 때 함께 고친다.
  - `v0.4.0` — 실패(manifest 0.3.2). 버전을 올리기 전이라 맞다.
