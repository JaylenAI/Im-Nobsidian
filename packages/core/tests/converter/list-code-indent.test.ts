/**
 * S-24 — 목록 안 코드블록이 받은 노트에서도 목록 안에 남는다.
 *
 * Notion 은 목록 항목의 자식 코드블록을 경계 펜스만 탭으로 들여쓰고 코드는 열 0 에 둔 채 내보낸다
 * (실측 — 아래 입력은 모두 실제 export 모양이다). 그대로 쓰면 Obsidian 은 열 0 의 코드 줄에서
 * 목록을 끝내, 목록 안에는 빈 코드블록이 · 목록 밖에는 코드가 문단으로 보였다(실볼트 12노트 · 37곳).
 */
import { describe, it, expect } from "vitest";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { alignNestedCodeBodies } from "../../src/converter/container-indent.js";
import { respace } from "../../src/converter/post-processors/block-spacer.js";
import { lintRenderedMarkdown } from "../../src/audit/render.js";

const lines = (...rows: string[]): string => rows.join("\n");

/** 받은 노트 — orchestrator 와 같은 순서(변환기 → BlockSpacer, 압축 export). */
const pull = (nfm: string): string => respace(notionEnhancedToObsidian(nfm), true);

describe("alignNestedCodeBodies — 목록 안 코드 줄을 펜스 깊이로(S-24)", () => {
  it("글머리표 항목의 코드 — 코드 줄이 펜스와 같은 탭을 입는다(빈 줄은 빈 줄)", () => {
    const nfm = lines(
      "- 목록",
      "\t```shell",
      "ls -al",
      "  indented",
      "",
      "빈 줄 뒤",
      "\t```",
      "- 둘째",
    );
    expect(alignNestedCodeBodies(nfm)).toBe(
      lines(
        "- 목록",
        "\t```shell",
        "\tls -al",
        "\t  indented",
        "",
        "\t빈 줄 뒤",
        "\t```",
        "- 둘째",
      ),
    );
  });

  it("두 단계 중첩 — 부모 항목의 깊이만큼", () => {
    const nfm = lines("- 둘째", "\t- 안쪽", "\t\t```python", "def f():", "    return 1", "\t\t```");
    expect(alignNestedCodeBodies(nfm)).toBe(
      lines("- 둘째", "\t- 안쪽", "\t\t```python", "\t\tdef f():", "\t\t    return 1", "\t\t```"),
    );
  });

  it("번호 · 할 일 항목도 목록 항목이다", () => {
    expect(alignNestedCodeBodies(lines("1. 번호", "\t```javascript", "x()", "\t```"))).toBe(
      lines("1. 번호", "\t```javascript", "\tx()", "\t```"),
    );
    expect(alignNestedCodeBodies(lines("- [ ] 할 일", "\t```bash", "echo", "\t```"))).toBe(
      lines("- [ ] 할 일", "\t```bash", "\techo", "\t```"),
    );
  });

  it("자식 문단 · 앞선 코드블록을 건너 부모 항목을 찾는다", () => {
    const nfm = lines(
      "- 형제 뒤",
      "\t자식 문단",
      "\t```python",
      "print(1)",
      "\t```",
      "\t```js",
      "x()",
      "\t```",
      "\t코드 뒤 문단",
    );
    expect(alignNestedCodeBodies(nfm)).toBe(
      lines(
        "- 형제 뒤",
        "\t자식 문단",
        "\t```python",
        "\tprint(1)",
        "\t```",
        "\t```js",
        "\tx()",
        "\t```",
        "\t코드 뒤 문단",
      ),
    );
  });

  it("정렬하지 않은 앞 코드블록(문단의 자식)의 열 0 코드 줄도 건너 부모 항목을 찾는다", () => {
    const nfm = lines("- 항목", "\t문단", "\t\t```js", "x", "\t\t```", "\t```py", "y", "\t```");
    expect(alignNestedCodeBodies(nfm)).toBe(
      lines("- 항목", "\t문단", "\t\t```js", "x", "\t\t```", "\t```py", "\ty", "\t```"),
    );
  });

  it("코드 속 ``` 줄이 있으면 경계 펜스를 그보다 길게 넓힌다", () => {
    const nfm = lines(
      "- 코드 속 펜스",
      "\t```markdown",
      "예시:",
      "```bash",
      "echo hi",
      "```",
      "끝",
      "\t```",
    );
    expect(alignNestedCodeBodies(nfm)).toBe(
      lines(
        "- 코드 속 펜스",
        "\t````markdown",
        "\t예시:",
        "\t```bash",
        "\techo hi",
        "\t```",
        "\t끝",
        "\t````",
      ),
    );
  });

  it("코드 속 탭은 코드다 — 구조 탭 한 겹만 더한다", () => {
    const nfm = lines("- 탭 코드", "\t```go", "func main() {", "\tfmt.Println(1)", "}", "\t```");
    expect(alignNestedCodeBodies(nfm)).toBe(
      lines("- 탭 코드", "\t```go", "\tfunc main() {", "\t\tfmt.Println(1)", "\t}", "\t```"),
    );
  });

  it("문단의 자식 코드는 둔다 — Obsidian 에 들여쓸 자리가 없다", () => {
    const nfm = lines("문단 부모", "\t```plain text", "child of paragraph", "\t```", "끝");
    expect(alignNestedCodeBodies(nfm)).toBe(nfm);
  });

  it("열 0 코드 · 인용 안 코드는 둔다", () => {
    const top = lines("- 목록", "```js", "x", "```");
    expect(alignNestedCodeBodies(top)).toBe(top);
    const quoted = lines("- 목록", "\t> [!note]", "\t> ```js", "\t> x", "\t> ```");
    expect(alignNestedCodeBodies(quoted)).toBe(quoted);
  });

  it("닫는 펜스의 들여쓰기가 다르면 둔다 — 어디까지가 코드인지 확신할 수 없다", () => {
    const nfm = lines("- 목록", "\t```sh", "ls", "```", "- 다음");
    expect(alignNestedCodeBodies(nfm)).toBe(nfm);
  });

  it("공백으로 들여쓴 펜스는 NFM 이 아니다 — 둔다", () => {
    const authored = lines("- 목록", "    ```sh", "    ls", "    ```");
    expect(alignNestedCodeBodies(authored)).toBe(authored);
  });
});

describe("BlockSpacer — 목록 자식 코드블록은 항목에 붙고 구조 탭만 편다(S-24)", () => {
  it("두 칸 들여쓴 목록 자식 펜스도 항목에 붙는다", () => {
    const md = lines("- 항목", "  ```js", "  x", "  ```", "- 다음");
    expect(respace(md, true)).toBe(md);
  });

  it("코드 줄이 구조 탭을 입지 않았으면 펜스도 펴지 않는다 — 코드 속 탭과 가릴 수 없다", () => {
    const md = lines("- 항목", "\t\t```js", "x", "\t\t```");
    expect(respace(md, true)).toBe(md);
  });

  it("닫는 펜스가 구조 탭을 입지 않았으면 펴지 않는다", () => {
    const md = lines("- 목록", "\t```sh", "\tls", "```");
    expect(respace(md, true)).toBe(md);
  });

  it("닫히지 않은 블록은 펴지 않는다 — 문서 끝까지 코드라 구조 탭인지 알 수 없다", () => {
    const md = lines("- 항목", "\t```js", "\tx", "\ty");
    expect(respace(md, true)).toBe(md);
  });

  it("목록 코드 뒤 수식 속 탭은 수식이다 — 구조 탭 폭이 다음 블록으로 새지 않는다", () => {
    const md = lines("- 항목", "\t```js", "\tx", "\t```", "$$", "\t\\alpha", "$$");
    expect(respace(md, true)).toBe(
      lines("- 항목", "    ```js", "    x", "    ```", "", "$$", "\t\\alpha", "$$"),
    );
  });
});

describe("받은 노트 — 목록 안 코드블록이 목록 안에 남는다(S-24)", () => {
  it("구조 탭은 목록 줄처럼 4칸이 되고 코드블록은 항목에 붙는다", () => {
    const nfm = lines(
      "앞 문단",
      "- 목록",
      "\t```shell",
      "ls -al",
      "  indented",
      "",
      "빈 줄 뒤",
      "\t```",
      "- 둘째",
      "\t- 안쪽",
      "\t\t```python",
      "def f():",
      "    return 1",
      "\t\t```",
      "1. 번호",
      "\t```javascript",
      "x()",
      "\t```",
      "- 탭 코드",
      "\t```go",
      "func main() {",
      "\tfmt.Println(1)",
      "}",
      "\t```",
      "끝",
    );
    expect(pull(nfm)).toBe(
      lines(
        "앞 문단",
        "",
        "- 목록",
        "    ```shell",
        "    ls -al",
        "      indented",
        "",
        "    빈 줄 뒤",
        "    ```",
        "- 둘째",
        "    - 안쪽",
        "        ```python",
        "        def f():",
        "            return 1",
        "        ```",
        "1. 번호",
        "    ```javascript",
        "    x()",
        "    ```",
        "- 탭 코드",
        "    ```go",
        "    func main() {",
        "    \tfmt.Println(1)",
        "    }",
        "    ```",
        "",
        "끝",
      ),
    );
  });

  it("자식 문단과 코드가 섞여도 한 항목이다", () => {
    const nfm = lines(
      "- 형제 뒤",
      "\t자식 문단",
      "\t```python",
      "print(1)",
      "\t```",
      "\t코드 뒤 문단",
      "끝",
    );
    expect(pull(nfm)).toBe(
      lines(
        "- 형제 뒤",
        "    자식 문단",
        "    ```python",
        "    print(1)",
        "    ```",
        "    코드 뒤 문단",
        "",
        "끝",
      ),
    );
  });

  it("코드 속 ``` 줄 — 넓힌 펜스 안에서 빈 줄이 끼지 않는다", () => {
    const nfm = lines(
      "- 코드 속 펜스",
      "\t```markdown",
      "예시:",
      "```bash",
      "echo hi",
      "```",
      "끝",
      "\t```",
      "- 다음",
    );
    expect(pull(nfm)).toBe(
      lines(
        "- 코드 속 펜스",
        "    ````markdown",
        "    예시:",
        "    ```bash",
        "    echo hi",
        "    ```",
        "    끝",
        "    ````",
        "- 다음",
      ),
    );
  });

  it("받은 노트에 렌더 결함이 없다", () => {
    const nfm = lines(
      "- 목록",
      "\t```shell",
      "ls",
      "\t```",
      "- 둘째",
      "\t- 안쪽",
      "\t\t```python",
      "x",
      "\t\t```",
    );
    expect(lintRenderedMarkdown(pull(nfm))).toEqual([]);
  });

  it("다시 올리는 markdown 은 받은 노트 그대로다 — 목록 4칸 · 펜스 4칸(Notion 이 같은 구조로 읽는다, 실측)", () => {
    const pulled = pull(lines("- 둘째", "\t- 안쪽", "\t\t```python", "x", "\t\t```", "- 다음"));
    expect(obsidianToNotionEnhanced(pulled)).toBe(pulled);
  });
});

/**
 * M3 — 콜아웃 · 토글 안 목록 항목의 코드가 항목 밖으로 납작해졌다. 컨테이너 본문을 내어 쓸 때 코드 펜스의 줄머리를
 * 모두 지워, 펜스가 항목과 같은 깊이가 되었다(2026-10-21 실측: Obsidian 은 코드를 항목 밖에 그린다). 입력은 실제
 * export 모양이다. push 모양은 실 Notion 에서 콜아웃 › 목록 › 코드(글 앞 탭 없음)로 읽혔다.
 */
describe("콜아웃 · 토글 안 목록의 코드 — 항목 안에 남는다(M3)", () => {
  const CALLOUT_LIST_CODE = lines(
    '<callout icon="💡">',
    "\t메모",
    "\t- 항목",
    "\t\t```javascript",
    "let a = 1;",
    "let b = 2;",
    "\t\t```",
    "\t- 둘째",
    "</callout>",
    "뒤 문단",
  );

  it("콜아웃 — 펜스와 코드가 항목 안 깊이(탭 하나)를 입는다", () => {
    expect(pull(CALLOUT_LIST_CODE)).toBe(
      lines(
        "> [!tip] 메모",
        "> - 항목",
        "> \t```javascript",
        "> \tlet a = 1;",
        "> \tlet b = 2;",
        "> \t```",
        "> - 둘째",
        "",
        "뒤 문단",
      ),
    );
  });

  it.each([
    [
      "토글",
      lines(
        "<details>",
        "<summary>접기</summary>",
        "\t- 항목",
        "\t\t```js",
        "x",
        "\t\t```",
        "</details>",
      ),
      lines("> [!toggle]- 접기", "> - 항목", "> \t```js", "> \tx", "> \t```"),
    ],
    [
      "콜아웃 속 콜아웃",
      lines(
        '<callout icon="💡">',
        "\t메모",
        '\t<callout icon="📝">',
        "\t\t안",
        "\t\t- 항목",
        "\t\t\t```js",
        "x",
        "\t\t\t```",
        "\t</callout>",
        "</callout>",
      ),
      lines("> [!tip] 메모", "> > [!note] 안", "> > - 항목", "> > \t```js", "> > \tx", "> > \t```"),
    ],
    [
      "두 단계 목록",
      lines(
        '<callout icon="💡">',
        "\t메모",
        "\t- 항목",
        "\t\t- 안쪽",
        "\t\t\t```js",
        "x",
        "\t\t\t```",
        "</callout>",
      ),
      lines("> [!tip] 메모", "> - 항목", "> \t- 안쪽", "> \t\t```js", "> \t\tx", "> \t\t```"),
    ],
  ])("%s — 코드가 제 항목 안에 남는다", (_name, nfm, expected) => {
    expect(pull(nfm)).toBe(expected);
  });

  it("다시 올리면 펜스가 항목의 자식 깊이 · 코드 글은 앞 탭 없이(실 Notion 에서 구조가 같다)", () => {
    expect(obsidianToNotionEnhanced(pull(CALLOUT_LIST_CODE))).toBe(
      lines(
        '<callout icon="💡">',
        "\t메모",
        "\t- 항목",
        "\t\t```javascript",
        "\tlet a = 1;",
        "\tlet b = 2;",
        "\t\t```",
        "\t- 둘째",
        "</callout>",
        "",
        "뒤 문단",
      ),
    );
  });

  it("목록 항목이 아닌 콜아웃 본문의 코드는 그대로 줄머리 없이 둔다", () => {
    const nfm = lines('<callout icon="💡">', "\t메모", "\t```js", "x", "\t```", "</callout>");
    expect(pull(nfm)).toBe(lines("> [!tip] 메모", "> ```js", "> x", "> ```"));
  });

  it("문단의 자식 코드는 줄머리 없이 둔다 — 들여 쓰면 Obsidian 이 문단의 이어진 글로 읽는다", () => {
    const nfm = lines(
      '<callout icon="💡">',
      "\t메모",
      "\t문단",
      "\t\t```js",
      "x",
      "\t\t```",
      "</callout>",
    );
    expect(pull(nfm)).toBe(lines("> [!tip] 메모", "> 문단", "> ```js", "> x", "> ```"));
  });
});
