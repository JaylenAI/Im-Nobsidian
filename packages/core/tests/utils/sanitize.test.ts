import { describe, it, expect } from "vitest";
import {
  FILE_NAME_MAX_BYTES,
  legacySanitizeFileName,
  sanitizeFileName,
} from "../../src/utils/sanitize.js";

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

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

  it("영문은 200자에서 자른다 — 예전과 같다", () => {
    const long = "a".repeat(300);
    expect(sanitizeFileName(long)).toHaveLength(200);
  });

  it("한글은 바이트로 센다 — 255 바이트를 넘는 이름은 ext4 · APFS 에 만들 수 없다", () => {
    const name = sanitizeFileName("가".repeat(150));
    expect(bytesOf(name)).toBeLessThanOrEqual(FILE_NAME_MAX_BYTES);
    expect(name).toBe("가".repeat(66));
    // 붙는 것 중 가장 긴 것을 붙여도 255 안쪽.
    expect(bytesOf(`${name} (${"0".repeat(32)}).notion.json`)).toBeLessThanOrEqual(255);
  });

  it("이모지 · 조합 이모지를 가운데서 자르지 않는다", () => {
    const family = "👨‍👩‍👧"; // ZWJ 로 이은 한 글자(18 바이트)
    const name = sanitizeFileName(family.repeat(20));
    expect(name).toBe(family.repeat(11));
    expect(sanitizeFileName("😀".repeat(60))).toBe("😀".repeat(50));
  });

  it("자른 자리의 끝 공백 · 마침표를 지운다", () => {
    expect(sanitizeFileName(`${"a".repeat(198)}. b`)).toBe("a".repeat(198));
  });

  it("링크에서 뜻이 있는 # ^ 를 _ 로 — [[a#b]] 는 노트 a 의 제목 b 를 가리킨다", () => {
    expect(sanitizeFileName("C# 정리")).toBe("C_ 정리");
    expect(sanitizeFileName("x^2 풀이")).toBe("x_2 풀이");
  });

  it("예전 규칙(0.12 전)은 # 를 두고 UTF-16 200자에서 잘랐다", () => {
    expect(legacySanitizeFileName("C# 정리")).toBe("C# 정리");
    expect(legacySanitizeFileName("가".repeat(250))).toBe("가".repeat(200));
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
