import { describe, it, expect } from "vitest";
import {
  conflictCopyPath,
  freeConflictCopyPath,
  isConflictCopyPath,
} from "../../src/conflict/conflict-copy.js";

describe("「복제」 해소 사본의 이름", () => {
  it.each([
    ["폴더/노트.md", "폴더/노트.conflict.md"],
    // Obsidian 은 `.MD` 도 노트로 연다 — 사본도 노트로 남게 확장자를 그대로 둔다(B15).
    ["노트.MD", "노트.conflict.MD"],
    ["그림.png", "그림.png.conflict"],
  ])("%s → %s", (path, copy) => {
    expect(conflictCopyPath(path)).toBe(copy);
    expect(isConflictCopyPath(copy)).toBe(copy.endsWith(".md") || copy.endsWith(".MD"));
  });

  it("노트가 아닌 이름은 사본으로 보지 않는다", () => {
    expect(isConflictCopyPath("폴더/이름.conflict")).toBe(false);
    expect(isConflictCopyPath("폴더/노트.md")).toBe(false);
  });

  it("둘째 사본부터 번호를 붙이고, 그 이름도 사본으로 본다", () => {
    expect(conflictCopyPath("폴더/노트.md", 2)).toBe("폴더/노트 2.conflict.md");
    expect(isConflictCopyPath("폴더/노트 2.conflict.md")).toBe(true);
  });

  it("볼트에 있는 사본은 건너뛰고 비어 있는 다음 번호를 고른다", async () => {
    const taken = new Set(["폴더/노트.conflict.md", "폴더/노트 2.conflict.md"]);

    expect(await freeConflictCopyPath("폴더/노트.md", async (path) => taken.has(path))).toBe(
      "폴더/노트 3.conflict.md",
    );
    expect(await freeConflictCopyPath("폴더/새.md", async (path) => taken.has(path))).toBe(
      "폴더/새.conflict.md",
    );
  });
});
