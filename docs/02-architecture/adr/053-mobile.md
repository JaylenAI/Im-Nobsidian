# ADR-053: 모바일 — Node 모듈은 빌드가 갈음하고, 상태 DB 는 볼트 어댑터로 쓴다

> 상태: 승인
> 결정일: 2026-10-31
> 「Notion API 한계를 빼고 모두 동기화」 계획의 P11

## 맥락

플러그인은 `isDesktopOnly: true` 였다. 모바일(iOS · Android)에서 뜨지 않는 까닭이 셋이었다.

1. **main.js 가 처음에 Node 모듈을 불렀다** — core 와 의존성이 `fs` · `path` · `crypto` · `os` · `url` · `events` 를 읽는다. 모바일
   WebView 에는 Node 가 없어 `require("fs")` 에서 스크립트 전체가 멈춘다. 전역 `Buffer` · `process` 도 없다
2. **정규식 lookbehind** — iOS 16.4 앞의 JavaScript 는 `(?<!…)` · `(?<=…)` 를 읽지 못해, 그런 정규식 하나가 든 스크립트가 뜨지
   않는다. 커뮤니티 디렉터리 검사도 데스크톱 전용이 아닌 플러그인의 lookbehind 를 거절한다
3. **상태 DB 를 Node `fs` 로 썼다** — 한 번에 갈아 끼우기(ADR-026) · CLI 와 나누는 잠금이 Node 파일 API 다

## 결정

1. **빌드가 Node 모듈을 `src/platform/shims/` 로 잇는다**(esbuild `alias`). shim 은 데스크톱이면 전역 `require` 로 진짜 모듈을
   그대로 넘기고(예전과 같다), 모바일이면 갈음한다 — `path` 는 POSIX(Node 의 것을 옮김), `crypto.createHash("sha256")` 는 순수 JS,
   `randomUUID` 는 웹 crypto, `events` 는 최소 구현. 갈음할 수 없는 파일 API 는 부를 때 «모바일에는 X 가 없음» 을 던진다 — 모바일
   경로는 부르지 않는다. 전역 `Buffer` 는 없을 때만 npm `buffer` 로 둔다. vfile 의 `process.cwd()` 도 shim
2. **lookbehind 를 없앤다** — `LookbehindRegExp`(맞은 자리의 앞 글을 함수로 본다)로 바꾸고, 예전 정규식과 무작위 글 3,000개씩 결과를
   견준다. 소스(`no-lookbehind.test.ts`)와 빌드한 main.js(`distribution.test.ts`)에 다시 들어오지 않게 막는다
3. **모바일의 상태 DB 는 볼트 어댑터로 쓴다**(`AdapterStateDbFile`, `Platform.isDesktopApp` 으로 가른다) — 옆 `.tmp` 에 다 쓰고, 원래
   파일을 지우고, 이름을 바꾼다(어댑터의 이름 바꾸기는 대상이 있으면 던진다). 지운 뒤 끊겼으면 열 때 `.tmp` 를 되살린다. 쓰기 전에
   크기 · 수정 시각으로 다른 곳(클라우드 동기화)이 바꾼 파일인지 보고 그러면 쓰지 않는다(데스크톱과 같은 `StateDbCopyStaleError`).
   잠금은 없다 — 폰에서는 CLI 가 돌지 않는다
4. **앱이 가려지면 상태 DB 를 바로 쓴다**(`visibilitychange`) — 평소에는 5초 모아 쓴다. 모바일은 다른 앱으로 넘어가면 곧 멈추고
   onunload 를 부르지 않는다
5. 연결 폴더 찾기(ADR-038)도 모바일은 어댑터의 `list` 로 걷는다 — core 와 같은 규칙, 같은 답인지 같은 볼트 모양으로 시험한다
6. `manifest.json` 의 `isDesktopOnly` 를 `false` 로

## 이유

- shim 은 데스크톱 동작을 바꾸지 않는다 — 진짜 모듈을 그대로 넘긴다(시험: 같은 함수 객체). core 를 모바일용으로 고치면 CLI 까지
  흔든다
- 갈음한 구현은 Node 와 답이 같은지 무작위로 견준다 — SHA-256 600가지 길이(블록 경계 포함) · path 2,000가지 조합. path 는 처음
  견줄 때 `extname("..")` · 끝 `/` · `basename(p, ext)` 셋이 달랐다 — Node 의 구현을 그대로 옮겼다
- 어댑터의 갈아 끼우기는 원자적이지 않다(지우기 · 이름 바꾸기가 따로). 그 사이에 끊겨도 다 쓴 `.tmp` 가 남으므로 기록을 잃지 않는다

## 검증

- **Node 없는 곳에서 빌드한 main.js 를 띄운다**(`tests/platform/no-node-load.test.ts`) — `vm` 맥락에 `require` · `Buffer` · `process`
  가 없고 Obsidian 은 `obsidian` · `@codemirror/*` 만 준다. 메모리 볼트 · HTTP 로 받는 메모리 Notion 으로 Push → 상태 DB 를 어댑터로
  씀 → 다시 불러와 Pull · Push(새로 만들지 않음) · 앱을 가리면 바로 씀. 어댑터 분기를 없애거나 Buffer 를 빼거나 가림 처리를 빼면
  깨진다(변이 시험)
- **실제 Obsidian 1.12.4 + 실제 Notion**(격리 창) — 데스크톱 경로는 예전대로(잠금 파일 · Node 로 씀). 모바일 흉내: `Platform` 을
  모바일로, 전역 `require` 는 `obsidian` · `@codemirror` 만, `Buffer` 를 치우고 플러그인을 다시 켰다 — Node 모듈 일곱을 하나도 받지
  못한 채 떴고, Push 3 · Notion 에서 고친 것 Pull · 다시 불러와 Push 0 · Sync 0, 잠금 파일 없음. `emulateMobile` 화면(태블릿 ·
  390px)에서 사이드바 · 설정
- 디렉터리 검사(obsidian-workflows, `isDesktopOnly: false`)에 오류 0. lookbehind 규칙이 켜져 있는지는 `(?<=` 를 넣어 잡히는 것으로
  보았다(규칙은 리터럴의 `(?<!x)` 를 놓친다 — 우리 시험이 둘 다 막는다)

## 트레이드오프 · 확인하지 못한 것

- **실기기(iOS · Android)에서는 돌려 보지 않았다.** 모바일 어댑터(Capacitor)의 `list` · `rename` · `remove` · `stat` 가 데스크톱
  어댑터와 같다고 보고 썼다
- 모바일에는 잠금이 없다 — 같은 볼트를 두 기기에서 동기화 서비스로 나누며 둘 다 Notion 과 동기화하면, 같은 토큰이라 서로의 쓰기를
  제 것으로 본다(README 「Edits from the same token elsewhere」). 한 번에 한 기기에서 동기화하라고 안내한다
- 강제 종료(가림 알림 없이)되면 마지막 5초의 기록은 잃을 수 있다 — 데스크톱의 갑작스러운 종료와 같다
