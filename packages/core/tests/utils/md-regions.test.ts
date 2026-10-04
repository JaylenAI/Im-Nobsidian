import { describe, it, expect } from "vitest";
import {
  computeAnchor,
  indentWidth,
  inlineCodeRanges,
  mapOutsideCode,
  mapOutsideCodeFences,
  mapOutsideInlineCode,
} from "../../src/utils/md-regions.js";

describe("computeAnchor", () => {
  it("같은 줄 접두(4자 이상)를 앵커로 반환", () => {
    const content = "이 문단의 중간에 [[위키링크]] 가 있다";
    const idx = content.indexOf("[[");
    const anchor = computeAnchor(content, idx);
    expect(anchor.trim().length).toBeGreaterThanOrEqual(4);
    expect(content.includes(anchor)).toBe(true);
  });

  it("줄 첫머리면 직전 비어있지 않은 줄을 앵커로 반환", () => {
    const content = "앞 문단입니다.\n\n%%주석%%";
    const anchor = computeAnchor(content, content.indexOf("%%"));
    expect(anchor).toBe("앞 문단입니다.");
  });

  it("문서 선두면 빈 앵커", () => {
    expect(computeAnchor("%%주석%% 뒤 내용", 0)).toBe("");
  });

  it("같은 줄 접두는 32자 이내로 제한", () => {
    const long = "가".repeat(100);
    const content = `${long}X`;
    const anchor = computeAnchor(content, content.length - 1);
    expect(anchor.length).toBeLessThanOrEqual(32);
  });

  it("직전 줄 앵커는 48자 이내로 제한", () => {
    const content = `${"나".repeat(100)}\n\nX`;
    const anchor = computeAnchor(content, content.length - 1);
    expect(anchor.length).toBeLessThanOrEqual(48);
  });
});

describe("mapOutsideCodeFences", () => {
  it("펜스 밖 텍스트에만 함수를 적용", () => {
    const content = "밖1\n```js\n안\n```\n밖2";
    const result = mapOutsideCodeFences(content, (seg) =>
      seg.replace(/밖/g, "OUT").replace(/안/g, "IN"),
    );
    expect(result).toBe("OUT1\n```js\n안\n```\nOUT2");
  });

  it("~~~ 펜스도 인식", () => {
    const content = "밖\n~~~\n안 %%주석%%\n~~~";
    const result = mapOutsideCodeFences(content, (seg) => seg.replace(/%%[^%]*%%/g, ""));
    expect(result).toContain("%%주석%%");
  });

  it("펜스가 없으면 전체에 적용", () => {
    expect(mapOutsideCodeFences("a b a", (s) => s.replace(/a/g, "c"))).toBe("c b c");
  });

  it("닫히지 않은 펜스는 끝까지 코드로 취급", () => {
    const content = "밖\n```\n안1\n안2";
    const result = mapOutsideCodeFences(content, (seg) => seg.replace(/안/g, "X"));
    expect(result).toBe("밖\n```\n안1\n안2");
  });

  // S-25 — 마크다운 예제를 담은 코드의 ```bash 줄에서 구간을 닫으면 그 뒤 코드가 치환된다.
  it("코드 속 정보 문자열이 붙은 펜스 줄에서 닫지 않는다", () => {
    const content = "밖\n```md\n```bash\n안\n```\n밖";
    expect(mapOutsideCodeFences(content, (seg) => seg.replace(/[밖안]/g, "X"))).toBe(
      "X\n```md\n```bash\n안\n```\nX",
    );
  });

  it("여는 것보다 짧은 펜스에서 닫지 않는다", () => {
    const content = "밖\n````md\n```\n안\n```\n````\n밖";
    expect(mapOutsideCodeFences(content, (seg) => seg.replace(/[밖안]/g, "X"))).toBe(
      "X\n````md\n```\n안\n```\n````\nX",
    );
  });

  it("여는 쪽보다 3칸 넘게 들여쓴 펜스에서 닫지 않는다", () => {
    const content = "```\n    ```\n안\n```\n밖";
    expect(mapOutsideCodeFences(content, (seg) => seg.replace(/[밖안]/g, "X"))).toBe(
      "```\n    ```\n안\n```\nX",
    );
  });

  it("여는 쪽보다 3칸까지 들여쓴 펜스는 닫는다", () => {
    const content = "```\n안\n   ```\n밖";
    expect(mapOutsideCodeFences(content, (seg) => seg.replace(/[밖안]/g, "X"))).toBe(
      "```\n안\n   ```\nX",
    );
  });

  it("탭은 4칸이다 — 탭으로 들여쓴 펜스는 열 0 펜스를 닫지 않는다", () => {
    const content = "```\n\t```\n안\n```\n밖";
    expect(mapOutsideCodeFences(content, (seg) => seg.replace(/[밖안]/g, "X"))).toBe(
      "```\n\t```\n안\n```\nX",
    );
  });

  it("CRLF 노트의 닫는 펜스도 닫는다", () => {
    const content = "```js\r\n안\r\n```\r\n밖";
    expect(mapOutsideCodeFences(content, (seg) => seg.replace(/[밖안]/g, "X"))).toBe(
      "```js\r\n안\r\n```\r\nX",
    );
  });

  it("정보 문자열에 백틱이 있는 줄은 펜스가 아니다 — 인라인 코드", () => {
    expect(mapOutsideCodeFences("```js``` 밖\n밖", (seg) => seg.replace(/밖/g, "X"))).toBe(
      "```js``` X\nX",
    );
  });

  it("들여쓰기된 펜스도 인식", () => {
    const content = "밖\n  ```\n  안\n  ```\n밖";
    const result = mapOutsideCodeFences(content, (seg) => seg.replace(/안/g, "X"));
    expect(result).toContain("안");
  });

  // S-26 — 줄머리 공백 뒤의 펜스만 보아, 콜아웃 속 코드의 주석을 push 가 지웠다.
  it("콜아웃 · 겹 인용 안 펜스도 코드다", () => {
    const content =
      "밖\n> [!note] 밖\n> ```html\n> <!-- 안 -->\n> ```\n> 밖\n\n> > ```\n> > 안\n> > ```";
    expect(mapOutsideCodeFences(content, (seg) => seg.replace(/[밖안]/g, "X"))).toBe(
      "X\n> [!note] X\n> ```html\n> <!-- 안 -->\n> ```\n> X\n\n> > ```\n> > 안\n> > ```",
    );
  });

  it("인용이 끝나면 닫히지 않은 펜스도 거기서 끝난다", () => {
    expect(mapOutsideCodeFences("> ```\n> 안\n밖", (seg) => seg.replace(/[밖안]/g, "X"))).toBe(
      "> ```\n> 안\nX",
    );
  });

  it("CRLF 노트의 인용 안 펜스도 닫는다", () => {
    const content = "> ```js\r\n> 안\r\n> ```\r\n밖";
    expect(mapOutsideCodeFences(content, (seg) => seg.replace(/[밖안]/g, "X"))).toBe(
      "> ```js\r\n> 안\r\n> ```\r\nX",
    );
  });

  it("목록 표시로 연 펜스 — 항목 안에서 닫고, 닫히지 않으면 항목이 끝날 때 끝난다", () => {
    const closed = "- ```py\n  안\n\n  안\n  ```\n밖";
    expect(mapOutsideCodeFences(closed, (seg) => seg.replace(/[밖안]/g, "X"))).toBe(
      closed.replace("밖", "X"),
    );
    expect(mapOutsideCodeFences("- ```py\n  안\n밖", (seg) => seg.replace(/[밖안]/g, "X"))).toBe(
      "- ```py\n  안\nX",
    );
  });
});

describe("indentWidth", () => {
  it("탭은 다음 4칸 경계까지 민다", () => {
    expect(indentWidth("")).toBe(0);
    expect(indentWidth("    ")).toBe(4);
    expect(indentWidth("\t")).toBe(4);
    expect(indentWidth("  \t")).toBe(4);
    expect(indentWidth(" \t ")).toBe(5);
    expect(indentWidth("\t\t")).toBe(8);
  });
});

describe("mapOutsideInlineCode", () => {
  const mark = (content: string) =>
    mapOutsideInlineCode(content, (seg) => seg.replace(/링크/g, "X"));

  it("짝이 맞는 백틱 스팬 안은 건너뛴다", () => {
    expect(mark("링크 `링크` 링크")).toBe("X `링크` X");
  });

  it("백틱 개수가 같은 짝만 스팬이다", () => {
    expect(mark("``링크 ` 링크`` 링크")).toBe("``링크 ` 링크`` X");
  });

  it("닫는 백틱이 없으면 평문이다", () => {
    expect(mark("링크 ` 링크")).toBe("X ` X");
  });

  it("문단 안에서 줄을 넘는 스팬은 코드다", () => {
    expect(mark("링크 `링크\n링크` 링크")).toBe("X `링크\n링크` X");
  });

  it("문단을 넘는 짝은 스팬이 아니다 — 두 문단의 홑 백틱 사이를 코드로 보지 않는다", () => {
    expect(mark("홑 ` 하나\n\n[[링크]]\n\n또 ` 하나")).toBe("홑 ` 하나\n\n[[X]]\n\n또 ` 하나");
  });

  it("공백만 있는 줄도 문단을 가른다", () => {
    expect(mark("홑 ` 하나\n  \n링크 `")).toBe("홑 ` 하나\n  \nX `");
  });
});

describe("inlineCodeRanges", () => {
  it("백틱을 포함한 스팬 구간을 원문 offset 으로 준다", () => {
    const content = "a `b` c ``d ` e`` f";
    expect(inlineCodeRanges(content).map(([s, e]) => content.slice(s, e))).toEqual([
      "`b`",
      "``d ` e``",
    ]);
  });

  it("짝 없는 백틱 · 문단을 넘는 짝은 구간이 아니다", () => {
    expect(inlineCodeRanges("홑 ` 하나\n\n또 ` 하나")).toEqual([]);
  });
});

describe("mapOutsideCode — offset", () => {
  it("조각의 offset 은 입력 기준 절대 위치다", () => {
    const content = "앞 `코드` 링크\n```\n링크\n```\n뒤 링크";
    const seen: Array<[string, number]> = [];
    mapOutsideCode(content, (seg, offset) => {
      seen.push([seg, offset]);
      return seg;
    });
    for (const [seg, offset] of seen) expect(content.slice(offset, offset + seg.length)).toBe(seg);
    expect(seen.map(([seg]) => seg).join("|")).toBe("앞 | 링크|뒤 링크");
  });
});
