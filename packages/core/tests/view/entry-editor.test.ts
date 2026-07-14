import { describe, it, expect, vi, beforeEach } from "vitest";
import { EntryEditor } from "../../src/view/entry-editor.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import matter from "gray-matter";

function createMockVaultFs(): VaultFS & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    readFile: vi.fn(async (path: string) => {
      if (path in files) return files[path]!;
      throw new Error(`File not found: ${path}`);
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      files[path] = content;
    }),
    readBinary: vi.fn(),
    writeBinary: vi.fn(),
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
    exists: vi.fn(),
    ensureFolder: vi.fn(),
    listMarkdownFiles: vi.fn(async () => []),
    listNonMarkdownFiles: vi.fn(async () => []),
  };
}

describe("EntryEditor", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let editor: EntryEditor;

  beforeEach(() => {
    vaultFs = createMockVaultFs();
    editor = new EntryEditor(vaultFs);
  });

  describe("updateProperty", () => {
    it("문자열 속성 변경", async () => {
      vaultFs.files["jobs/A사.md"] = "---\ntitle: A사\n단계: 서류전형\n---\n\n본문";

      await editor.updateProperty("jobs/A사.md", "단계", "면접");

      const updated = matter(vaultFs.files["jobs/A사.md"]!);
      expect(updated.data["단계"]).toBe("면접");
      expect(updated.data.title).toBe("A사");
      expect(updated.content.trim()).toBe("본문");
    });

    it("새 속성 추가", async () => {
      vaultFs.files["jobs/B사.md"] = "---\ntitle: B사\n---\n\n내용";

      await editor.updateProperty("jobs/B사.md", "직무", "개발");

      const updated = matter(vaultFs.files["jobs/B사.md"]!);
      expect(updated.data["직무"]).toBe("개발");
    });

    it("숫자 속성 변경", async () => {
      vaultFs.files["test.md"] = "---\ntitle: Test\nscore: 80\n---\n";

      await editor.updateProperty("test.md", "score", 95);

      const updated = matter(vaultFs.files["test.md"]!);
      expect(updated.data.score).toBe(95);
    });

    it("boolean 속성 변경", async () => {
      vaultFs.files["test.md"] = "---\ntitle: Test\ndone: false\n---\n";

      await editor.updateProperty("test.md", "done", true);

      const updated = matter(vaultFs.files["test.md"]!);
      expect(updated.data.done).toBe(true);
    });

    it("배열 속성 변경", async () => {
      vaultFs.files["test.md"] = "---\ntitle: Test\ntags:\n  - a\n  - b\n---\n";

      await editor.updateProperty("test.md", "tags", ["x", "y", "z"]);

      const updated = matter(vaultFs.files["test.md"]!);
      expect(updated.data.tags).toEqual(["x", "y", "z"]);
    });

    it("null로 설정", async () => {
      vaultFs.files["test.md"] = "---\ntitle: Test\nstatus: active\n---\n";

      await editor.updateProperty("test.md", "status", null);

      const updated = matter(vaultFs.files["test.md"]!);
      expect(updated.data.status).toBeNull();
    });
  });

  describe("createEntry", () => {
    it("새 파일 생성", async () => {
      const path = await editor.createEntry("jobs", "새 회사", { 단계: "지원" });

      expect(path).toBe("jobs/새 회사.md");
      expect(vaultFs.ensureFolder).toHaveBeenCalledWith("jobs");

      const content = vaultFs.files[path]!;
      const parsed = matter(content);
      expect(parsed.data.title).toBe("새 회사");
      expect(parsed.data["단계"]).toBe("지원");
    });

    it("특수문자 제거된 파일명", async () => {
      const path = await editor.createEntry("db", "A/B:C*D", {});

      expect(path).toBe("db/A_B_C_D.md");
    });
  });

  describe("moveEntryToGroup", () => {
    it("그룹 속성 변경", async () => {
      vaultFs.files["jobs/A사.md"] = "---\ntitle: A사\n단계: 서류전형\n---\n";

      const entry = {
        path: "jobs/A사.md",
        title: "A사",
        properties: { 단계: "서류전형" },
      };

      await editor.moveEntryToGroup(entry, "단계", "면접");

      const updated = matter(vaultFs.files["jobs/A사.md"]!);
      expect(updated.data["단계"]).toBe("면접");
    });
  });

  describe("updateDate", () => {
    it("날짜 속성 변경", async () => {
      vaultFs.files["test.md"] = "---\ntitle: Test\ndue: 2026-05-01\n---\n";

      await editor.updateDate("test.md", "due", "2026-06-15");

      // D3: 날짜는 저작 관행대로 따옴표 없이 기록된다(gray-matter 재파싱 시 Date 객체)
      expect(vaultFs.files["test.md"]).toContain("due: 2026-06-15\n");
    });
  });
});
