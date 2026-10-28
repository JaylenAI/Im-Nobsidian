import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeVaultFS } from "../../src/sync/node-vault-fs.js";

describe("NodeVaultFS", () => {
  let tempDir: string;
  let vaultFs: NodeVaultFS;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-test-"));
    vaultFs = new NodeVaultFS(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("readFile", () => {
    it("파일 읽기", async () => {
      await writeFile(join(tempDir, "test.md"), "# Hello", "utf-8");
      const content = await vaultFs.readFile("test.md");
      expect(content).toBe("# Hello");
    });

    it("존재하지 않는 파일 읽기 시 에러", async () => {
      await expect(vaultFs.readFile("nope.md")).rejects.toThrow();
    });
  });

  describe("writeFile", () => {
    it("파일 쓰기", async () => {
      await vaultFs.writeFile("output.md", "content");
      const result = await readFile(join(tempDir, "output.md"), "utf-8");
      expect(result).toBe("content");
    });

    it("중첩 디렉토리 자동 생성", async () => {
      await vaultFs.writeFile("a/b/c/deep.md", "deep content");
      const result = await readFile(join(tempDir, "a/b/c/deep.md"), "utf-8");
      expect(result).toBe("deep content");
    });
  });

  describe("writeBinary", () => {
    it("바이너리 파일 쓰기", async () => {
      const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      await vaultFs.writeBinary("img.png", data);
      const result = await readFile(join(tempDir, "img.png"));
      expect(Buffer.compare(result, data)).toBe(0);
    });
  });

  describe("deleteFile", () => {
    it("파일 삭제", async () => {
      await writeFile(join(tempDir, "delete-me.md"), "gone");
      await vaultFs.deleteFile("delete-me.md");
      await expect(vaultFs.exists("delete-me.md")).resolves.toBe(false);
    });
  });

  describe("moveFile", () => {
    it("파일 이동", async () => {
      await writeFile(join(tempDir, "src.md"), "moving");
      await vaultFs.moveFile("src.md", "dest/moved.md");

      await expect(vaultFs.exists("src.md")).resolves.toBe(false);
      const content = await vaultFs.readFile("dest/moved.md");
      expect(content).toBe("moving");
    });
  });

  describe("exists", () => {
    it("존재하는 파일 true", async () => {
      await writeFile(join(tempDir, "here.md"), "yes");
      await expect(vaultFs.exists("here.md")).resolves.toBe(true);
    });

    it("없는 파일 false", async () => {
      await expect(vaultFs.exists("nope.md")).resolves.toBe(false);
    });
  });

  describe("ensureFolder", () => {
    it("폴더 생성", async () => {
      await vaultFs.ensureFolder("new/folder/path");
      await vaultFs.writeFile("new/folder/path/test.md", "ok");
      const content = await vaultFs.readFile("new/folder/path/test.md");
      expect(content).toBe("ok");
    });
  });

  describe("removeEmptyFolder", () => {
    it("빈 폴더만 지운다 — 숨김 파일이 남은 폴더 · 없는 폴더 · 파일은 false", async () => {
      await mkdir(join(tempDir, "빈/안쪽"), { recursive: true });
      await mkdir(join(tempDir, "숨김"), { recursive: true });
      await writeFile(join(tempDir, "숨김/.DS_Store"), "");
      await writeFile(join(tempDir, "노트.md"), "본문");

      await expect(vaultFs.removeEmptyFolder("빈")).resolves.toBe(false);
      await expect(vaultFs.removeEmptyFolder("빈/안쪽")).resolves.toBe(true);
      await expect(vaultFs.removeEmptyFolder("빈")).resolves.toBe(true);
      await expect(vaultFs.exists("빈")).resolves.toBe(false);

      await expect(vaultFs.removeEmptyFolder("숨김")).resolves.toBe(false);
      await expect(vaultFs.exists("숨김/.DS_Store")).resolves.toBe(true);
      await expect(vaultFs.removeEmptyFolder("없음")).resolves.toBe(false);
      await expect(vaultFs.removeEmptyFolder("노트.md")).resolves.toBe(false);
    });
  });

  describe("listMarkdownFiles", () => {
    it("마크다운 파일만 리스트", async () => {
      await writeFile(join(tempDir, "note1.md"), "# Note 1");
      await writeFile(join(tempDir, "note2.md"), "# Note 2");
      await writeFile(join(tempDir, "image.png"), "binary");
      await writeFile(join(tempDir, "data.json"), "{}");

      const files = await vaultFs.listMarkdownFiles();

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.path).sort()).toEqual(["note1.md", "note2.md"]);
    });

    it("하위 폴더 재귀 탐색", async () => {
      await mkdir(join(tempDir, "sub"), { recursive: true });
      await writeFile(join(tempDir, "root.md"), "root");
      await writeFile(join(tempDir, "sub/child.md"), "child");

      const files = await vaultFs.listMarkdownFiles();

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.path).sort()).toEqual(["root.md", "sub/child.md"]);
    });

    it("숨김 폴더(.으로 시작) 무시", async () => {
      await mkdir(join(tempDir, ".hidden"), { recursive: true });
      await writeFile(join(tempDir, ".hidden/secret.md"), "secret");
      await writeFile(join(tempDir, "visible.md"), "visible");

      const files = await vaultFs.listMarkdownFiles();

      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe("visible.md");
    });

    it("content와 mtime 포함", async () => {
      await writeFile(join(tempDir, "note.md"), "# Hello World");

      const files = await vaultFs.listMarkdownFiles();

      expect(files[0]!.content).toBe("# Hello World");
      expect(files[0]!.mtime).toBeTruthy();
    });

    it("exclude 패턴으로 파일 제외", async () => {
      await mkdir(join(tempDir, "templates"), { recursive: true });
      await writeFile(join(tempDir, "note.md"), "keep");
      await writeFile(join(tempDir, "templates/tmpl.md"), "exclude");

      const filtered = new NodeVaultFS(tempDir, { exclude: ["templates/**"] });
      const files = await filtered.listMarkdownFiles();

      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe("note.md");
    });

    it("include 패턴으로 화이트리스트 필터링", async () => {
      await mkdir(join(tempDir, "docs"), { recursive: true });
      await mkdir(join(tempDir, "drafts"), { recursive: true });
      await writeFile(join(tempDir, "docs/guide.md"), "included");
      await writeFile(join(tempDir, "drafts/wip.md"), "excluded");
      await writeFile(join(tempDir, "root.md"), "excluded");

      const filtered = new NodeVaultFS(tempDir, { include: ["docs/**"] });
      const files = await filtered.listMarkdownFiles();

      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe("docs/guide.md");
    });

    it("include + exclude 동시 사용", async () => {
      await mkdir(join(tempDir, "notes"), { recursive: true });
      await mkdir(join(tempDir, "notes/private"), { recursive: true });
      await writeFile(join(tempDir, "notes/public.md"), "yes");
      await writeFile(join(tempDir, "notes/private/secret.md"), "no");
      await writeFile(join(tempDir, "other.md"), "no");

      const filtered = new NodeVaultFS(tempDir, {
        include: ["notes/**"],
        exclude: ["notes/private/**"],
      });
      const files = await filtered.listMarkdownFiles();

      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe("notes/public.md");
    });

    it(".im-nobsidian-ignore 파일로 제외", async () => {
      await writeFile(join(tempDir, ".im-nobsidian-ignore"), "drafts/**\n# comment\n\narchive/**");
      await mkdir(join(tempDir, "drafts"), { recursive: true });
      await mkdir(join(tempDir, "archive"), { recursive: true });
      await writeFile(join(tempDir, "note.md"), "keep");
      await writeFile(join(tempDir, "drafts/wip.md"), "skip");
      await writeFile(join(tempDir, "archive/old.md"), "skip");

      const filtered = new NodeVaultFS(tempDir);
      const files = await filtered.listMarkdownFiles();

      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe("note.md");
    });

    // Windows 는 chmod 로 읽기를 막지 못한다.
    it.skipIf(process.platform === "win32")(
      "읽지 못한 .im-nobsidian-ignore 는 빈 목록이 아니라 오류 — 제외한 파일이 올라가지 않게",
      async () => {
        const ignore = join(tempDir, ".im-nobsidian-ignore");
        await writeFile(ignore, "drafts/**\n");
        await chmod(ignore, 0o200);

        expect(() => new NodeVaultFS(tempDir)).toThrow("EACCES");
      },
    );
  });

  describe("경로 모양 · 패턴 (이슈 #8)", () => {
    it("하위 폴더의 경로를 / 로 잇는다 — 어느 OS 에서나", async () => {
      await mkdir(join(tempDir, "00 Me", "Daily"), { recursive: true });
      await writeFile(join(tempDir, "00 Me", "Daily", "a.md"), "a");
      await writeFile(join(tempDir, "00 Me", "img.png"), "png");

      expect((await vaultFs.listMarkdownFiles()).map((f) => f.path)).toEqual(["00 Me/Daily/a.md"]);
      expect((await vaultFs.listMarkdownFileStats()).map((f) => f.path)).toEqual([
        "00 Me/Daily/a.md",
      ]);
      expect((await vaultFs.listNonMarkdownFiles()).map((f) => f.path)).toEqual(["00 Me/img.png"]);
    });

    it("포함 패턴 폴더/**/*.md 가 폴더 안을 걷는다 — 예전에는 폴더를 빼 새 노트를 못 찾았다", async () => {
      await mkdir(join(tempDir, "00 Me", "Daily"), { recursive: true });
      await mkdir(join(tempDir, "02 Other"), { recursive: true });
      await writeFile(join(tempDir, "00 Me", "a.md"), "a");
      await writeFile(join(tempDir, "00 Me", "Daily", "b.md"), "b");
      await writeFile(join(tempDir, "02 Other", "c.md"), "c");

      const filtered = new NodeVaultFS(tempDir, { include: ["00 Me/**/*.md"] });
      const paths = (await filtered.listMarkdownFileStats()).map((f) => f.path).sort();

      expect(paths).toEqual(["00 Me/Daily/b.md", "00 Me/a.md"]);
    });

    it("excludesPath — 설정 · 무시 파일이 뺀 경로", async () => {
      await writeFile(join(tempDir, ".im-nobsidian-ignore"), "Private/\r\n");
      const filtered = new NodeVaultFS(tempDir, { include: ["**/*.md"], exclude: ["*.tmp.md"] });

      expect(filtered.excludesPath("Private/a.md")).toBe(true);
      expect(filtered.excludesPath("Private", "folder")).toBe(true);
      expect(filtered.excludesPath("Notes/x.tmp.md")).toBe(true);
      expect(filtered.excludesPath("Notes/a.md")).toBe(false);
      // 포함 패턴은 폴더를 빼지 않는다
      expect(filtered.excludesPath("Notes", "folder")).toBe(false);
      expect(filtered.excludesPath("Notes")).toBe(true);
    });
  });
});
