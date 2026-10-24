import { describe, expect, it } from "vitest";
import { PathFilter, toVaultPath } from "../../src/utils/path-filter.js";

describe("toVaultPath (이슈 #8)", () => {
  it("Windows relative() 의 \\ 를 / 로 잇는다", () => {
    expect(toVaultPath("00 Me\\Daily\\a.md", "\\")).toBe("00 Me/Daily/a.md");
  });

  it("POSIX 에서는 이름의 \\ 를 그대로 둔다", () => {
    expect(toVaultPath("a\\b.md", "/")).toBe("a\\b.md");
  });
});

describe("PathFilter — 포함 패턴 (이슈 #8)", () => {
  it("기본값 **/* 는 모두 받는다", () => {
    const filter = new PathFilter(["**/*"], []);
    expect(filter.excludesFile("a.md")).toBe(false);
    expect(filter.excludesFile("x/y/z.md")).toBe(false);
  });

  it("폴더/** 는 그 폴더 안만 받는다", () => {
    const filter = new PathFilter(["00 Me/**", "01 Projects/**"], []);
    expect(filter.excludesFile("00 Me/a.md")).toBe(false);
    expect(filter.excludesFile("01 Projects/sub/b.md")).toBe(false);
    expect(filter.excludesFile("02 Other/c.md")).toBe(true);
    expect(filter.excludesFile("00 Me2/a.md")).toBe(true);
  });

  it("폴더/**/*.md 는 폴더 바로 아래 노트도 받는다 — **/ 는 0 단계를 받는다", () => {
    const filter = new PathFilter(["00 Me/**/*.md"], []);
    expect(filter.excludesFile("00 Me/a.md")).toBe(false);
    expect(filter.excludesFile("00 Me/Daily/b.md")).toBe(false);
    expect(filter.excludesFile("00 Me/img.png")).toBe(true);
    expect(filter.excludesFile("Other/a.md")).toBe(true);
  });

  it("포함 패턴은 폴더를 막지 않는다 — 안의 파일이 정한다", () => {
    const filter = new PathFilter(["00 Me/**/*.md"], []);
    expect(filter.excludesFolder("00 Me")).toBe(false);
    expect(filter.excludesFolder("Other")).toBe(false);
  });

  it("**/*.md 는 볼트 맨 위의 노트도 받는다", () => {
    const filter = new PathFilter(["**/*.md"], []);
    expect(filter.excludesFile("root.md")).toBe(false);
    expect(filter.excludesFile("a/b.md")).toBe(false);
  });

  it("패턴의 \\ · 앞뒤 / · ./ 를 볼트 경로 모양으로 맞춘다", () => {
    const filter = new PathFilter(["00 Me\\**", "./01 Projects/"], []);
    expect(filter.excludesFile("00 Me/a.md")).toBe(false);
    expect(filter.excludesFile("01 Projects/b.md")).toBe(false);
    expect(filter.excludesFile("02/c.md")).toBe(true);
  });

  it("정규식 글자가 든 이름도 글자 그대로 견준다", () => {
    const filter = new PathFilter(["(Work)+/*.md"], []);
    expect(filter.excludesFile("(Work)+/a.md")).toBe(false);
    expect(filter.excludesFile("Work/a.md")).toBe(true);
  });
});

describe("PathFilter — 제외 패턴", () => {
  it("폴더 이름 · 끝 / · /** 는 그 폴더와 안을 뺀다", () => {
    for (const pattern of ["Private", "Private/", "Private/**"]) {
      const filter = new PathFilter([], [pattern]);
      expect(filter.excludesFolder("Private")).toBe(true);
      expect(filter.excludesFile("Private/a.md")).toBe(true);
      expect(filter.excludesFile("Private/x/y.md")).toBe(true);
      expect(filter.excludesFile("PrivateNotes/a.md")).toBe(false);
    }
  });

  it("/ 없는 글롭은 어느 깊이의 이름에나 맞는다", () => {
    const filter = new PathFilter([], ["*.pdf", "draft-*"]);
    expect(filter.excludesFile("a/b/x.pdf")).toBe(true);
    expect(filter.excludesFolder("notes/draft-1")).toBe(true);
    expect(filter.excludesFile("notes/draft-1/a.md")).toBe(true);
    expect(filter.excludesFile("notes/final/a.md")).toBe(false);
  });

  it("/ 있는 글롭은 맨 위부터 맞추고, 맞는 폴더의 안도 뺀다", () => {
    const filter = new PathFilter([], ["Archive/*"]);
    expect(filter.excludesFolder("Archive/2024")).toBe(true);
    expect(filter.excludesFile("Archive/2024/a.md")).toBe(true);
    expect(filter.excludesFile("Archive/a.md")).toBe(true);
    expect(filter.excludesFile("x/Archive/a.md")).toBe(false);
  });

  it("포함에 맞아도 제외가 이긴다", () => {
    const filter = new PathFilter(["00 Me/**"], ["00 Me/Private"]);
    expect(filter.excludesFile("00 Me/a.md")).toBe(false);
    expect(filter.excludesFile("00 Me/Private/b.md")).toBe(true);
  });

  it("빈 패턴 · 공백만 든 줄은 버린다", () => {
    const filter = new PathFilter([], ["", "  ", "/"]);
    expect(filter.excludesFile("a.md")).toBe(false);
  });
});
