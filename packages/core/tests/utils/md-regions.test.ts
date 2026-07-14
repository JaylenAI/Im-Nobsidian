import { describe, it, expect } from "vitest";
import { computeAnchor, mapOutsideCodeFences } from "../../src/utils/md-regions.js";

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

  it("들여쓰기된 펜스도 인식", () => {
    const content = "밖\n  ```\n  안\n  ```\n밖";
    const result = mapOutsideCodeFences(content, (seg) => seg.replace(/안/g, "X"));
    expect(result).toContain("안");
  });
});
