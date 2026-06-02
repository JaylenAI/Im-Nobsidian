import { describe, it, expect } from "vitest";
import { sanitizeFileName } from "../../src/utils/sanitize.js";

describe("sanitizeFileName", () => {
  it("정상 파일명은 그대로 반환", () => {
    expect(sanitizeFileName("hello-world")).toBe("hello-world");
  });

  it("금지 문자를 _로 치환", () => {
    expect(sanitizeFileName("file<name>test")).toBe("file_name_test");
    expect(sanitizeFileName("a/b\\c")).toBe("a_b_c");
    expect(sanitizeFileName("what?")).toBe("what_");
  });

  it("끝 마침표 제거", () => {
    expect(sanitizeFileName("file...")).toBe("file");
  });

  it("200자 제한", () => {
    const long = "a".repeat(300);
    expect(sanitizeFileName(long)).toHaveLength(200);
  });

  it("위키링크 문법을 깨는 대괄호를 _로 치환 (M5)", () => {
    // [[Attention [2017]]] 처럼 basename 에 `[`/`]` 가 남으면 Obsidian 파서가 첫 `]]`
    // 에서 조기 종료해 링크가 깨진다. 파일명 단계에서 봉합하면 basename 파생 위키링크가
    // 항상 안전해진다(원본 제목은 frontmatter title 에 보존되므로 무손실).
    expect(sanitizeFileName("Attention [2017]")).toBe("Attention _2017_");
    expect(sanitizeFileName("[DRAFT] Notes")).toBe("_DRAFT_ Notes");
    expect(sanitizeFileName("a]b[c")).toBe("a_b_c");
  });

  it("대괄호 치환은 멱등이다 (M5)", () => {
    const once = sanitizeFileName("Attention [2017]");
    expect(sanitizeFileName(once)).toBe(once);
  });

  it("Windows 예약어 앞에 _ 추가", () => {
    expect(sanitizeFileName("CON")).toBe("_CON");
    expect(sanitizeFileName("PRN")).toBe("_PRN");
    expect(sanitizeFileName("NUL")).toBe("_NUL");
  });

  it("빈 문자열은 _untitled 반환", () => {
    expect(sanitizeFileName("")).toBe("_untitled");
    expect(sanitizeFileName("...")).toBe("_untitled");
  });
});
