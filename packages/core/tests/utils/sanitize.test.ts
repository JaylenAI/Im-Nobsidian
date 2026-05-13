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
