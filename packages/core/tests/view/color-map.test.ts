import { describe, it, expect } from "vitest";
import { getNotionColor, getNotionBgColor, generateColorCSS } from "../../src/view/color-map.js";

describe("getNotionColor", () => {
  it("정의된 색상 반환", () => {
    expect(getNotionColor("red")).toBe("#D44C47");
    expect(getNotionColor("blue")).toBe("#337EA9");
    expect(getNotionColor("green")).toBe("#448361");
  });

  it("default 색상", () => {
    expect(getNotionColor("default")).toBe("#37352F");
  });

  it("알 수 없는 색상은 default", () => {
    expect(getNotionColor("unknown_color")).toBe("#37352F");
  });
});

describe("getNotionBgColor", () => {
  it("정의된 배경색 반환", () => {
    expect(getNotionBgColor("red")).toBe("#FDEBEC");
    expect(getNotionBgColor("blue")).toBe("#E7F3F8");
    expect(getNotionBgColor("green")).toBe("#EDF3EC");
  });

  it("알 수 없는 색상은 default 배경", () => {
    expect(getNotionBgColor("nope")).toBe("#F1F1EF");
  });
});

describe("generateColorCSS", () => {
  it("CSS 변수 생성", () => {
    const css = generateColorCSS();
    expect(css).toContain(":root {");
    expect(css).toContain("--notion-color-red: #D44C47");
    expect(css).toContain("--notion-bg-blue: #E7F3F8");
    expect(css).toContain("}");
  });

  it("10색 전부 포함", () => {
    const css = generateColorCSS();
    const colors = [
      "default",
      "gray",
      "brown",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
      "pink",
      "red",
    ];
    for (const c of colors) {
      expect(css).toContain(`--notion-color-${c}`);
      expect(css).toContain(`--notion-bg-${c}`);
    }
  });
});
