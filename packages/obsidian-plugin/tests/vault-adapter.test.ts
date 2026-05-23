import { describe, it, expect, vi, beforeEach } from "vitest";
import { TFile, type Vault } from "obsidian";
import { ObsidianVaultAdapter } from "../src/vault-adapter.js";

function createFile(path: string, opts?: { size?: number; mtime?: number }): TFile {
  const file = new TFile();
  file.path = path;
  const parts = path.split("/");
  file.name = parts[parts.length - 1]!;
  file.extension = file.name.includes(".") ? file.name.split(".").pop()! : "";
  file.stat = {
    mtime: opts?.mtime ?? 1716336000000,
    size: opts?.size ?? 100,
    ctime: 1716336000000,
  };
  return file;
}

describe("ObsidianVaultAdapter", () => {
  let adapter: ObsidianVaultAdapter;
  let fileContents: Map<string, string>;
  let fileObjects: Map<string, TFile>;
  let vault: Record<string, unknown>;

  beforeEach(() => {
    fileContents = new Map();
    fileObjects = new Map();

    const hello = createFile("notes/hello.md", { size: 50 });
    fileObjects.set("notes/hello.md", hello);
    fileContents.set("notes/hello.md", "# Hello\nWorld");

    const project = createFile("notes/project.md", { size: 100 });
    fileObjects.set("notes/project.md", project);
    fileContents.set("notes/project.md", "---\ntitle: Project\n---\nContent");

    const image = createFile("attachments/image.png", { size: 2048 });
    fileObjects.set("attachments/image.png", image);
    fileContents.set("attachments/image.png", "");

    const config = createFile(".im-nobsidian/config.json", { size: 10 });
    fileObjects.set(".im-nobsidian/config.json", config);
    fileContents.set(".im-nobsidian/config.json", "{}");

    vault = {
      getAbstractFileByPath: vi.fn((p: string) => fileObjects.get(p) ?? null),
      read: vi.fn(async (f: TFile) => fileContents.get(f.path) ?? ""),
      readBinary: vi.fn(async () => new ArrayBuffer(8)),
      modify: vi.fn(async (f: TFile, content: string) => {
        fileContents.set(f.path, content);
      }),
      modifyBinary: vi.fn(async () => {}),
      create: vi.fn(async (path: string, content: string) => {
        const f = createFile(path);
        fileObjects.set(path, f);
        fileContents.set(path, content);
        return f;
      }),
      createBinary: vi.fn(async (path: string) => {
        const f = createFile(path);
        fileObjects.set(path, f);
        return f;
      }),
      createFolder: vi.fn(async () => {}),
      rename: vi.fn(async (file: TFile, newPath: string) => {
        const content = fileContents.get(file.path) ?? "";
        fileObjects.delete(file.path);
        fileContents.delete(file.path);
        file.path = newPath;
        fileObjects.set(newPath, file);
        fileContents.set(newPath, content);
      }),
      trash: vi.fn(async (file: TFile) => {
        fileObjects.delete(file.path);
        fileContents.delete(file.path);
      }),
      getMarkdownFiles: vi.fn(() => {
        return [...fileObjects.values()].filter((f) => f.extension === "md");
      }),
      getFiles: vi.fn(() => [...fileObjects.values()]),
    };

    adapter = new ObsidianVaultAdapter(vault as unknown as Vault);
  });

  describe("readFile", () => {
    it("마크다운 파일 읽기", async () => {
      const content = await adapter.readFile("notes/hello.md");
      expect(content).toBe("# Hello\nWorld");
    });

    it("존재하지 않는 파일은 에러", async () => {
      await expect(adapter.readFile("nonexistent.md")).rejects.toThrow("파일을 찾을 수 없습니다");
    });
  });

  describe("readBinary", () => {
    it("바이너리 파일 읽기", async () => {
      const data = await adapter.readBinary("attachments/image.png");
      expect(data).toBeInstanceOf(Buffer);
    });

    it("존재하지 않는 파일은 에러", async () => {
      await expect(adapter.readBinary("nonexistent.png")).rejects.toThrow(
        "파일을 찾을 수 없습니다",
      );
    });
  });

  describe("writeFile", () => {
    it("기존 파일 수정", async () => {
      await adapter.writeFile("notes/hello.md", "# Updated");
      expect(vault.modify).toHaveBeenCalled();
    });

    it("새 파일 생성", async () => {
      await adapter.writeFile("notes/new.md", "New content");
      expect(vault.create).toHaveBeenCalledWith("notes/new.md", "New content");
    });

    it("중첩 폴더에 파일 생성 시 폴더 자동 생성", async () => {
      await adapter.writeFile("deep/nested/file.md", "Content");
      expect(vault.createFolder).toHaveBeenCalled();
    });
  });

  describe("writeBinary", () => {
    it("기존 바이너리 파일 수정", async () => {
      const data = Buffer.from([1, 2, 3]);
      await adapter.writeBinary("attachments/image.png", data);
      expect(vault.modifyBinary).toHaveBeenCalled();
    });

    it("새 바이너리 파일 생성", async () => {
      const data = Buffer.from([4, 5, 6]);
      await adapter.writeBinary("attachments/new.png", data);
      expect(vault.createBinary).toHaveBeenCalled();
    });
  });

  describe("deleteFile", () => {
    it("파일 삭제 (휴지통 이동)", async () => {
      await adapter.deleteFile("notes/hello.md");
      expect(vault.trash).toHaveBeenCalled();
    });

    it("존재하지 않는 파일 삭제는 무시", async () => {
      await adapter.deleteFile("nonexistent.md");
      expect(vault.trash).not.toHaveBeenCalled();
    });
  });

  describe("moveFile", () => {
    it("파일 이동", async () => {
      await adapter.moveFile("notes/hello.md", "archive/hello.md");
      expect(vault.rename).toHaveBeenCalled();
    });

    it("존재하지 않는 파일 이동은 에러", async () => {
      await expect(adapter.moveFile("nonexistent.md", "dest.md")).rejects.toThrow(
        "파일을 찾을 수 없습니다",
      );
    });
  });

  describe("exists", () => {
    it("존재하는 파일은 true", async () => {
      expect(await adapter.exists("notes/hello.md")).toBe(true);
    });

    it("존재하지 않는 파일은 false", async () => {
      expect(await adapter.exists("nonexistent.md")).toBe(false);
    });
  });

  describe("ensureFolder", () => {
    it("폴더 생성 호출", async () => {
      await adapter.ensureFolder("new-folder");
      expect(vault.createFolder).toHaveBeenCalledWith("new-folder");
    });
  });

  describe("listMarkdownFiles", () => {
    it("마크다운 파일만 반환 (.im-nobsidian 제외)", async () => {
      const mdFiles = await adapter.listMarkdownFiles();
      expect(mdFiles.length).toBe(2);
      expect(mdFiles.every((f) => f.path.endsWith(".md"))).toBe(true);
      expect(mdFiles.every((f) => !f.path.startsWith(".im-nobsidian/"))).toBe(true);
    });

    it("파일 내용 포함", async () => {
      const mdFiles = await adapter.listMarkdownFiles();
      const hello = mdFiles.find((f) => f.path === "notes/hello.md");
      expect(hello?.content).toBe("# Hello\nWorld");
    });
  });

  describe("listMarkdownFileStats", () => {
    it("마크다운 파일 통계만 반환 (.im-nobsidian 제외)", async () => {
      const stats = await adapter.listMarkdownFileStats();
      expect(stats.length).toBe(2);
      expect(stats.every((s) => !s.path.startsWith(".im-nobsidian/"))).toBe(true);
    });

    it("mtime과 size 포함", async () => {
      const stats = await adapter.listMarkdownFileStats();
      expect(stats[0]!.mtime).toBeDefined();
      expect(stats[0]!.size).toBeGreaterThan(0);
    });
  });

  describe("getFileStat", () => {
    it("파일 통계 반환", async () => {
      const stat = await adapter.getFileStat("notes/hello.md");
      expect(stat).not.toBeNull();
      expect(stat!.path).toBe("notes/hello.md");
      expect(stat!.size).toBe(50);
    });

    it("존재하지 않는 파일은 null", async () => {
      expect(await adapter.getFileStat("nonexistent.md")).toBeNull();
    });
  });

  describe("listNonMarkdownFiles", () => {
    it("비-마크다운 파일만 반환 (.im-nobsidian 제외)", async () => {
      const nonMdFiles = await adapter.listNonMarkdownFiles();
      expect(nonMdFiles.length).toBe(1);
      expect(nonMdFiles[0]!.path).toBe("attachments/image.png");
    });
  });
});
