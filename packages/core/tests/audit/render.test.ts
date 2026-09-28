/**
 * 렌더 감사 중 문맥이 필요한 규칙 — 목록 안 코드블록(⑤ · ⑱, S-24).
 *
 * 한 줄만 보고 판정하는 규칙(①~④)과 표 · 펜스 개수(⑦ · ⑧)는 렌더 게이트 코퍼스가 지킨다.
 * 여기는 4칸 들여쓴 펜스가 목록 자식인지, 목록 안 코드가 목록 밖으로 새는지를 본다.
 */
import { describe, it, expect } from "vitest";
import { lintRenderedMarkdown } from "../../src/audit/render.js";

const lines = (...rows: string[]): string => rows.join("\n");
const codes = (markdown: string): string[] =>
  lintRenderedMarkdown(markdown).map((f) => `${f.code}@${f.line}`);

describe("⑤ 코드펜스 4칸 들여쓰기 — 목록 · 콜아웃 밖", () => {
  it("문단 뒤의 4칸 펜스는 들여쓰기 코드블록이다 — 여는 줄 · 닫는 줄", () => {
    expect(codes(lines("문단", "", "    ```js", "    x", "    ```"))).toEqual(["⑤@3", "⑤@5"]);
  });

  it("목록 항목의 자식이면 정상이다 — 글머리표 · 번호 · 할 일 · 중첩", () => {
    expect(codes(lines("- 항목", "    ```js", "    x", "    ```"))).toEqual([]);
    expect(codes(lines("1. 번호", "    ```js", "    x", "    ```"))).toEqual([]);
    expect(codes(lines("- [ ] 할 일", "    ```sh", "    echo", "    ```"))).toEqual([]);
    expect(
      codes(lines("- 둘째", "    - 안쪽", "        ```python", "        x", "        ```")),
    ).toEqual([]);
  });

  it("자식 문단 · 빈 줄 · 앞선 코드블록을 건너 항목을 찾는다", () => {
    const md = lines(
      "- 항목",
      "    자식 문단",
      "",
      "    ```js",
      "    x",
      "    ```",
      "    ```py",
      "    y",
      "    ```",
    );
    expect(codes(md)).toEqual([]);
  });

  it("항목 내용보다 4칸 넘게 깊으면 항목 안의 들여쓰기 코드블록이다", () => {
    expect(codes(lines("- 항목", "      ```js", "      x", "      ```"))).toEqual(["⑤@2", "⑤@4"]);
  });

  it("항목 내용보다 얕으면 목록이 끝난다 — 번호 100. 뒤의 4칸 펜스", () => {
    expect(codes(lines("100. 항목", "    ```js", "    x", "    ```"))).toEqual(["⑤@2", "⑤@4"]);
  });

  it("코드 줄이 펜스보다 얕아도 항목 안이면 코드다 — 다음 펜스의 항목 찾기를 막지 않는다", () => {
    const md = lines("- 항목", "    ```js", "  x", "    ```", "    ```py", "    y", "    ```");
    expect(codes(md)).toEqual([]);
  });

  it("코드 속의 4칸 펜스 모양 줄은 코드다 — 마크다운 예제", () => {
    expect(codes(lines("````markdown", "    ```js", "    x", "    ```", "````"))).toEqual([]);
  });
});

describe("⑱ 목록 안 코드가 목록 밖으로 샌다", () => {
  it("Notion 이 내보낸 모양 그대로 — 코드 줄이 열 0 이면 목록과 코드블록이 끝난다", () => {
    const md = lines("- 목록", "\t```shell", "ls -al", "ls", "\t```", "- 둘째");
    expect(codes(md)).toEqual(["⑱@2"]);
  });

  it("펜스만 4칸으로 편 모양도 샌다 — 줄 하나만 얕아도", () => {
    const md = lines("- 목록", "    ```shell", "    ls -al", "echo leaked", "    ```");
    expect(codes(md)).toEqual(["⑱@2"]);
  });

  it("두 단계 중첩 — 부모 항목 내용보다 얕으면 샌다", () => {
    const md = lines("- 둘째", "    - 안쪽", "        ```python", "    x", "        ```");
    expect(codes(md)).toEqual(["⑱@3"]);
  });

  it("코드 줄이 항목 내용 깊이에 있으면 새지 않는다 — 빈 줄은 보지 않는다", () => {
    expect(codes(lines("- 목록", "    ```shell", "    ls", "", "    ls -al", "    ```"))).toEqual(
      [],
    );
    expect(codes(lines("- 목록", "  ```shell", "  ls", "  ```"))).toEqual([]);
  });

  it("닫히지 않은 목록 코드 — 문서 끝 줄까지 코드다", () => {
    expect(codes(lines("- 목록", "    ```sh", "    ls", "leak"))).toEqual(["⑧@0", "⑱@2"]);
  });

  it("항목 내용보다 얕은 펜스는 목록 밖 코드블록이다 — 목록 자식이 아니라 새는 것이 아니다", () => {
    expect(codes(lines("1. 항목", "  ```js", "x", "  ```"))).toEqual([]);
  });

  it("목록 밖 코드 · 문단 아래 들여쓴 펜스는 이 규칙 밖이다", () => {
    expect(codes(lines("- 목록", "", "```js", "x", "```"))).toEqual([]);
    expect(codes(lines("문단", "\t```js", "x", "\t```"))).toEqual([]);
  });
});
