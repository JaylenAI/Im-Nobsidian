/**
 * 코드 구간 가드 — 서식 태그 치환이 코드에 적힌 예제를 건드리지 않게 한다.
 *
 * 조각마다 치환하는 `mapOutsideCode` 는 코드를 사이에 둔 짝(`==a `b` c==`)을 놓치고, 글 전체에서
 * 백틱 짝을 세면 펜스의 백틱을 인라인 코드로 잡는다. `codeRanges` 는 펜스 줄 · 코드블록 안을 먼저
 * 가르고 그 밖에서만 인라인 코드를 찾는다.
 */
import { describe, it, expect } from "vitest";
import {
  codeRanges,
  isInsideRanges,
  replaceOutsideCode,
} from "../../src/converter/container-indent.js";

const inCode = (md: string, needle: string) => isInsideRanges(codeRanges(md), md.indexOf(needle));

describe("codeRanges", () => {
  it("펜스 줄 · 코드블록 안 · 인라인 코드가 코드다", () => {
    const md = "앞 `인라인` 뒤\n```html\n<b>예제</b>\n```\n본문";
    expect(inCode(md, "인라인")).toBe(true);
    expect(inCode(md, "```html")).toBe(true);
    expect(inCode(md, "<b>예제")).toBe(true);
    expect(inCode(md, "본문")).toBe(false);
    expect(inCode(md, "앞")).toBe(false);
  });

  it("두 코드블록 사이 글은 코드가 아니다 — 펜스 백틱을 인라인 짝으로 세지 않는다", () => {
    const md = "```js\na\n\nb\n```\n사이 글\n```py\nc\n```";
    expect(inCode(md, "사이 글")).toBe(false);
  });

  it("콜아웃 · 들여쓴 컨테이너 안의 펜스도 코드다", () => {
    expect(inCode("> [!note]\n> ```html\n> <u>x</u>\n> ```", "<u>x")).toBe(true);
    expect(inCode("<details>\n\t```html\n\t<u>x</u>\n\t```\n</details>", "<u>x")).toBe(true);
  });
});

describe("replaceOutsideCode", () => {
  const underline = (md: string) =>
    replaceOutsideCode(md, /<u>([\s\S]*?)<\/u>/g, (_m, text) => `[${text}]`);

  it("코드 밖에서 시작한 일치는 안에 인라인 코드를 품어도 바꾼다", () => {
    expect(underline("<u>a `b` c</u>")).toBe("[a `b` c]");
  });

  it("코드 안에서 시작한 일치는 그대로 둔다", () => {
    expect(underline("`<u>x</u>` 와 <u>y</u>")).toBe("`<u>x</u>` 와 [y]");
    expect(underline("```\n<u>x</u>\n```")).toBe("```\n<u>x</u>\n```");
  });

  it("없는 캡처는 undefined 로 넘긴다 — 선택 그룹", () => {
    const seen: Array<string | undefined> = [];
    replaceOutsideCode("a-b a", /a(-b)?/g, (m, dash) => {
      seen.push(dash);
      return m;
    });
    expect(seen).toEqual(["-b", undefined]);
  });
});
