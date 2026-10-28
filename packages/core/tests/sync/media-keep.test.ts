/**
 * 본문 push 가 바뀌지 않은 미디어를 다시 올리지 않는다.
 *
 * 예전에는 글 한 줄만 고쳐도 본문을 자리표시자로 통째로 바꾼 뒤 페이지의 미디어를 모두 다시 올렸다 —
 * 미디어마다 업로드 요청이 셋이고, Notion 의 블록 · 파일이 새로 바뀌었다. Notion 에서 받은 캡션 없는
 * 파일은 다시 올리면서 별칭(받은 이름)이 캡션으로 붙었다. 받은 본문의 미디어 URL 을 그대로 실어 본문을
 * 바꾸면 Notion 이 그 블록을 그대로 둔다(2026-10-12 실측 — 블록 id · 파일 id 가 같고 캡션만 실은 글).
 *
 * 메모리 Notion 의 미디어는 실제 markdown API 의 모양이다 — 이미지 `![캡션](서명 URL)`, 파일
 * `<file src="서명 URL">캡션</file>`. 서명 URL 의 경로 끝 둘이 파일 id 와 올라간 이름이다.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ImageHandler } from "../../src/sync/image-handler.js";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { recallUploadedMedia, rememberUploadedMedia } from "../../src/sync/uploaded-media.js";
import { encodeMarkerTarget } from "../../src/converter/marker-url.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { NotionClient } from "../../src/notion/client.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const SPACE_ID = "5d2f8a41-3c7e-4b19-9e0a-7f6d2c1b8a93";
const NOTE = `# 노트\n\n앞 문단\n\n![[assets/a.png|설명]]\n\n![[docs/계약서.pdf]]\n\n뒤 문단\n`;

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

function signedUrl(fileId: string, name: string): string {
  return (
    `https://prod-files-secure.s3.us-west-2.amazonaws.com/${SPACE_ID}/${fileId}/` +
    `${encodeURIComponent(name)}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=sig`
  );
}

function fileId(n: number): string {
  return `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
}

/** push 가 심는 자리표시자 한 줄. */
function marker(kind: "image" | "file", target: string): string {
  const name = target.split("|")[0]!.split("/").pop();
  return `> 📎 ${name} %% im-nobsidian:local-${kind}:${encodeMarkerTarget(target)} %%`;
}

describe("ImageHandler.keepUploadedMedia — 보낼 본문의 자리표시자를 Notion 의 그 파일로", () => {
  const FILES: Record<string, string> = { "assets/a.png": "PNG", "docs/계약서.pdf": "PDF" };
  let db: StateDB;
  let tempDir: string;
  let getPageMarkdown: ReturnType<typeof vi.fn>;
  let readBinary: ReturnType<typeof vi.fn>;
  let handler: ImageHandler;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-media-keep-"));
    db = StateDB.open(join(tempDir, "state.db"));
    getPageMarkdown = vi.fn();
    readBinary = vi.fn(async (path: string) => {
      const content = FILES[path];
      if (content === undefined)
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return Buffer.from(content);
    });
    const fs = {
      readBinary,
      exists: vi.fn(async (path: string) => path in FILES),
    } as unknown as VaultFS;
    handler = new ImageHandler(
      fs,
      "attachments",
      { getPageMarkdown } as unknown as NotionClient,
      undefined,
      {},
      db,
    );
    rememberUploadedMedia(db, "page-1", [
      {
        fileId: fileId(1),
        target: "assets/a.png|설명",
        localPath: "assets/a.png",
        fileHash: sha256("PNG"),
      },
      {
        fileId: fileId(2),
        target: "docs/계약서.pdf",
        localPath: "docs/계약서.pdf",
        fileHash: sha256("PDF"),
      },
    ]);
    getPageMarkdown.mockResolvedValue({
      markdown:
        `앞 문단\n![설명](${signedUrl(fileId(1), "a.png")})\n` +
        `<file src="${signedUrl(fileId(2), "계약서.pdf")}"></file>\n뒤 문단`,
    });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const body = (...lines: string[]) => lines.join("\n");
  const imageUrl = signedUrl(fileId(1), "a.png").split("?")[0];
  const fileUrl = signedUrl(fileId(2), "계약서.pdf").split("?")[0];

  it("바뀌지 않은 이미지 · 파일은 서명을 뗀 URL 로 싣는다 — 캡션은 노트의 설명", async () => {
    const markdown = body(
      "앞 문단 — 고침",
      marker("image", "assets/a.png|설명"),
      marker("file", "docs/계약서.pdf"),
      "뒤 문단",
    );

    const result = await handler.keepUploadedMedia("page-1", markdown, "Note.md");

    expect(result.markdown).toBe(
      body("앞 문단 — 고침", `![설명](${imageUrl})`, `<file src="${fileUrl}"></file>`, "뒤 문단"),
    );
    expect(result.kept.map((media) => media.fileId)).toEqual([fileId(1), fileId(2)]);
  });

  it("HTML 블록은 embed 태그로 싣는다 — Notion 이 그 블록을 그대로 둔다(2026-10-28 실측)", async () => {
    FILES["web/차트.html"] = "HTML";
    rememberUploadedMedia(db, "page-1", [
      {
        fileId: fileId(3),
        target: "web/차트.html",
        localPath: "web/차트.html",
        fileHash: sha256("HTML"),
      },
    ]);
    getPageMarkdown.mockResolvedValue({
      markdown: `앞 문단\n<embed src="${signedUrl(fileId(3), "차트.html")}"></embed>\n뒤 문단`,
    });

    const result = await handler.keepUploadedMedia(
      "page-1",
      body("앞 문단 — 고침", marker("file", "web/차트.html"), "뒤 문단"),
      "Note.md",
    );

    const htmlUrl = signedUrl(fileId(3), "차트.html").split("?")[0];
    expect(result.markdown).toBe(
      body("앞 문단 — 고침", `<embed src="${htmlUrl}"></embed>`, "뒤 문단"),
    );
    delete FILES["web/차트.html"];
  });

  it("콜아웃 · 목록 안 자리표시자는 들여쓰기를 지킨다", async () => {
    const markdown = body(
      "<callout>",
      `\t${marker("image", "assets/a.png|설명")}`,
      "</callout>",
      "- 항목",
      `  ${marker("file", "docs/계약서.pdf")}`,
    );

    const result = await handler.keepUploadedMedia("page-1", markdown, "Note.md");

    expect(result.markdown).toBe(
      body(
        "<callout>",
        `\t![설명](${imageUrl})`,
        "</callout>",
        "- 항목",
        `  <file src="${fileUrl}"></file>`,
      ),
    );
  });

  it("Notion 에서 캡션을 고쳐 받은 임베드도 같은 파일이다 — 보낼 캡션은 노트의 것", async () => {
    const result = await handler.keepUploadedMedia(
      "page-1",
      marker("image", "assets/a.png|새 설명"),
      "Note.md",
    );

    expect(result.markdown).toBe(`![새 설명](${imageUrl})`);
    expect(result.kept).toEqual([expect.objectContaining({ target: "assets/a.png|새 설명" })]);
  });

  it("볼트의 파일이 바뀌었으면 둔다 — 다시 올린다", async () => {
    FILES["assets/a.png"] = "PNG2";
    try {
      const markdown = marker("image", "assets/a.png|설명");

      const result = await handler.keepUploadedMedia("page-1", markdown, "Note.md");

      expect(result).toEqual({ markdown, kept: [] });
    } finally {
      FILES["assets/a.png"] = "PNG";
    }
  });

  it("기록과 다른 볼트 파일이면 두지 않는다 — 같은 바이트여도 pull 이 되살릴 파일이 달라진다", async () => {
    FILES["notes/a.png"] = "PNG";
    try {
      // 노트 폴더의 a.png 가 먼저 잡힌다(노트 폴더 → 루트 → 첨부 폴더). 기록은 assets/a.png 다.
      rememberUploadedMedia(db, "page-1", [
        {
          fileId: fileId(1),
          target: "a.png|설명",
          localPath: "assets/a.png",
          fileHash: sha256("PNG"),
        },
      ]);
      const markdown = marker("image", "a.png|설명");

      expect((await handler.keepUploadedMedia("page-1", markdown, "notes/Note.md")).kept).toEqual(
        [],
      );
      expect(readBinary).toHaveBeenCalledWith("notes/a.png");
    } finally {
      delete FILES["notes/a.png"];
    }
  });

  it("Notion 본문에 그 파일이 없으면 둔다 — Notion 에서 지운 미디어", async () => {
    getPageMarkdown.mockResolvedValue({ markdown: "앞 문단\n뒤 문단" });
    const markdown = marker("image", "assets/a.png|설명");

    expect(await handler.keepUploadedMedia("page-1", markdown, "Note.md")).toEqual({
      markdown,
      kept: [],
    });
  });

  it("같은 파일을 두 번 임베드했으면 Notion 에 있는 수만큼만 둔다", async () => {
    const markdown = body(
      marker("image", "assets/a.png|설명"),
      marker("image", "assets/a.png|설명"),
    );

    const result = await handler.keepUploadedMedia("page-1", markdown, "Note.md");

    expect(result.markdown).toBe(
      body(`![설명](${imageUrl})`, marker("image", "assets/a.png|설명")),
    );
    expect(result.kept).toHaveLength(1);
  });

  it("종류가 다르면 두지 않는다 — 이미지 자리에 파일 블록", async () => {
    getPageMarkdown.mockResolvedValue({
      markdown: `<file src="${signedUrl(fileId(1), "a.png")}"></file>`,
    });
    const markdown = marker("image", "assets/a.png|설명");

    expect((await handler.keepUploadedMedia("page-1", markdown, "Note.md")).kept).toEqual([]);
  });

  it("캡션에 서식으로 읽힐 글자가 있으면 다시 올린다 — 캡션은 글자 그대로 가야 한다", async () => {
    for (const caption of ["*강조*", "a_b", "[링크]", "x<y", "`코드`", "$1", "a\\b"]) {
      const markdown = marker("image", `assets/a.png|${caption}`);

      const result = await handler.keepUploadedMedia("page-1", markdown, "Note.md");

      expect(result.kept, caption).toEqual([]);
    }
  });

  it("코드 안의 자리표시자 모양 줄은 바꾸지 않는다", async () => {
    const markdown = body("```md", marker("image", "assets/a.png|설명"), "```");

    expect(await handler.keepUploadedMedia("page-1", markdown, "Note.md")).toEqual({
      markdown,
      kept: [],
    });
    expect(getPageMarkdown).toHaveBeenCalledTimes(1);
  });

  it("지문이 없는 옛 기록만 있으면 Notion 에 묻지도 않는다", async () => {
    rememberUploadedMedia(db, "page-1", [
      { fileId: fileId(1), target: "assets/a.png|설명", localPath: "assets/a.png" },
    ]);
    const markdown = marker("image", "assets/a.png|설명");

    expect(await handler.keepUploadedMedia("page-1", markdown, "Note.md")).toEqual({
      markdown,
      kept: [],
    });
    expect(getPageMarkdown).not.toHaveBeenCalled();
  });

  it("본문을 읽지 못하면 사유를 남기고 그대로 보낸다 — 다시 올릴 뿐이다", async () => {
    getPageMarkdown.mockRejectedValue(new Error("502 Bad Gateway"));
    const markdown = marker("image", "assets/a.png|설명");

    expect(await handler.keepUploadedMedia("page-1", markdown, "Note.md")).toEqual({
      markdown,
      kept: [],
    });
  });

  it("자리표시자가 없으면 Notion 에 묻지 않는다", async () => {
    expect(await handler.keepUploadedMedia("page-1", "글만", "Note.md")).toEqual({
      markdown: "글만",
      kept: [],
    });
    expect(getPageMarkdown).not.toHaveBeenCalled();
  });
});

interface MediaBody {
  readonly file_upload: { readonly id: string };
  readonly caption: { readonly text: { readonly content: string } }[];
}

/**
 * 메모리 Notion 에 미디어 블록을 더한다 — 자리표시자 줄은 quote 블록이고, 그 뒤에 붙인 미디어는
 * markdown API 의 모양으로 그 줄을 바꾼다. 올린 파일 이름을 올린 순서대로 돌려준다.
 */
function withMediaBlocks(notion: ReturnType<typeof memoryNotion>): string[] {
  const uploads = new Map<string, string>();
  const uploaded: string[] = [];
  let stored = 0;
  const childPages = notion.client.fetchAllChildren.getMockImplementation()!;

  notion.client.uploadFile.mockImplementation(async (_blob: Blob, name: string) => {
    const id = `upload-${uploads.size + 1}`;
    uploads.set(id, name);
    uploaded.push(name);
    return id;
  });
  notion.client.fetchAllChildren.mockImplementation(async (parentId: string) => {
    const lines = notion.pages.get(parentId)?.body.split("\n") ?? [];
    const placeholders = lines.flatMap((line, i) =>
      /^> 📎 .*%% im-nobsidian:local-/u.test(line)
        ? [
            {
              id: `${parentId}#${i}`,
              type: "quote",
              has_children: false,
              quote: { rich_text: [{ plain_text: line.slice(2) }] },
            },
          ]
        : [],
    );
    return [...placeholders, ...(await childPages(parentId))];
  });
  notion.client.appendChildBlocks.mockImplementation(
    async (
      parentId: string,
      blocks: ({ type: "image" | "file" | "pdf" | "video" | "audio" } & Record<
        string,
        MediaBody
      >)[],
      options?: { after?: string },
    ) => {
      const page = notion.touch(parentId);
      const lines = page.body.split("\n");
      const at = Number(options!.after!.split("#")[1]);
      const created = blocks.map((block) => {
        const media = block[block.type]!;
        const name = uploads.get(media.file_upload.id)!;
        const url = signedUrl(fileId(++stored), name);
        const caption = media.caption.map((c) => c.text.content).join("");
        // markdown API 는 PDF · 동영상 · 소리 블록을 그 이름의 태그로 준다(실측 2026-10-21).
        lines[at] =
          block.type === "image"
            ? `![${caption}](${url})`
            : `<${block.type} src="${url}">${caption}</${block.type}>`;
        return {
          id: `media-${stored}`,
          type: block.type,
          [block.type]: { type: "file", file: { url } },
        };
      });
      page.body = lines.join("\n");
      return created;
    },
  );
  return uploaded;
}

describe("본문 push 와 미디어 — 바뀌지 않은 미디어는 다시 올리지 않는다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let uploaded: string[];
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-media-keep-sync-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    uploaded = withMediaBlocks(notion);

    const fs = vault.fs();
    (fs.readBinary as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const content = vault.read(path);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return Buffer.from(content);
    });
    (fs.writeBinary as ReturnType<typeof vi.fn>).mockImplementation(
      async (path: string, data: Buffer) => vault.write(path, data.toString()),
    );
    orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, mediaRetryBaseMs: 0 },
      }),
      db,
      notion.client as never,
      fs,
      (async () =>
        new Response("받은 바이트", {
          status: 200,
          headers: { "content-type": "image/png" },
        })) as never,
    );
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function body(path: string): string {
    return notion.pages.get(db.getByPath(path)!.notionPageId!)!.body;
  }

  /** 본문의 미디어 파일 id — 서명 URL 의 경로 끝에서 둘째. */
  function mediaFileIds(path: string): string[] {
    return [...body(path).matchAll(/\/([0-9a-f-]{36})\/[^/?)"]+(?:\?[^)"]*)?[)"]/g)].map(
      (m) => m[1]!,
    );
  }

  async function pushEdit(path: string, edit: (text: string) => string): Promise<string[]> {
    vault.write(path, edit(vault.read(path)!));
    const before = uploaded.length;
    expect(await orchestrator.push()).toMatchObject({ failed: [] });
    return uploaded.slice(before);
  }

  it("글만 고친 push 는 미디어를 올리지 않는다 — Notion 의 그 파일이 남는다", async () => {
    vault.write("assets/a.png", "PNG");
    vault.write("docs/계약서.pdf", "PDF");
    vault.write("Note.md", NOTE);
    await orchestrator.push();
    expect(uploaded).toEqual(["a.png", "계약서.pdf"]);
    const before = mediaFileIds("Note.md");
    notion.client.deleteBlock.mockClear();
    notion.client.fetchAllChildren.mockClear();

    const pushed = await pushEdit("Note.md", (t) => t.replace("앞 문단", "앞 문단 — 고침"));

    expect(pushed).toEqual([]);
    // 자리표시자를 보내지 않았으니 블록을 훑어 찾지 않는다.
    expect(notion.client.fetchAllChildren).not.toHaveBeenCalled();
    expect(mediaFileIds("Note.md")).toEqual(before);
    expect(body("Note.md")).toContain("앞 문단 — 고침");
    expect(body("Note.md")).not.toContain("im-nobsidian");
    expect(notion.client.deleteBlock).not.toHaveBeenCalled();
  });

  it("노트에서 설명을 고치면 캡션만 바꾼다 — 기록도 새 임베드로 적는다", async () => {
    vault.write("assets/a.png", "PNG");
    vault.write("docs/계약서.pdf", "PDF");
    vault.write("Note.md", NOTE);
    await orchestrator.push();
    const pageId = db.getByPath("Note.md")!.notionPageId!;

    const pushed = await pushEdit("Note.md", (t) => t.replace("a.png|설명", "a.png|새 설명"));

    expect(pushed).toEqual([]);
    expect(body("Note.md")).toMatch(/^!\[새 설명\]\(/m);
    expect([...recallUploadedMedia(db, pageId).values()].map((media) => media.target)).toEqual([
      "assets/a.png|새 설명",
      "docs/계약서.pdf",
    ]);
  });

  it("PDF 는 PDF 블록으로 올리고, 글만 고친 push 는 그 블록을 둔다(B12)", async () => {
    vault.write("assets/a.png", "PNG");
    vault.write("docs/계약서.pdf", "PDF");
    vault.write("Note.md", NOTE);
    await orchestrator.push();
    expect(body("Note.md")).toMatch(/<pdf src="[^"]+"><\/pdf>/);
    const before = mediaFileIds("Note.md");

    expect(await pushEdit("Note.md", (t) => t.replace("뒤 문단", "뒤 문단 — 고침"))).toEqual([]);

    expect(body("Note.md")).toMatch(/<pdf src="[^"]+"><\/pdf>/);
    expect(mediaFileIds("Note.md")).toEqual(before);
  });

  it("볼트에서 바뀐 파일만 다시 올린다", async () => {
    vault.write("assets/a.png", "PNG");
    vault.write("docs/계약서.pdf", "PDF");
    vault.write("Note.md", NOTE);
    await orchestrator.push();
    const [, pdfBefore] = mediaFileIds("Note.md");

    vault.write("assets/a.png", "PNG — 새로 그림");
    const pushed = await pushEdit("Note.md", (t) => t.replace("앞 문단", "앞 문단 — 고침"));

    expect(pushed).toEqual(["a.png"]);
    expect(mediaFileIds("Note.md")[1]).toBe(pdfBefore);
    // 다음 push 는 새 파일도 둔다 — 올린 미디어 기록에 새 지문이 있다.
    expect(await pushEdit("Note.md", (t) => t.replace("뒤 문단", "뒤 문단 — 고침"))).toEqual([]);
  });

  it("지문이 없는 옛 기록은 한 번 더 올리고, 그다음부터 둔다", async () => {
    vault.write("assets/a.png", "PNG");
    vault.write("docs/계약서.pdf", "PDF");
    vault.write("Note.md", NOTE);
    await orchestrator.push();
    const pageId = db.getByPath("Note.md")!.notionPageId!;
    const legacy = [...recallUploadedMedia(db, pageId).values()].map(
      ({ fileId: id, target, localPath }) => ({ fileId: id, target, localPath }),
    );
    rememberUploadedMedia(db, pageId, legacy);

    expect(await pushEdit("Note.md", (t) => t.replace("앞 문단", "앞 문단 — 1"))).toEqual([
      "a.png",
      "계약서.pdf",
    ]);
    expect(await pushEdit("Note.md", (t) => t.replace("앞 문단 — 1", "앞 문단 — 2"))).toEqual([]);
  });

  it("Notion 에서 받은 미디어도 다시 올리지 않는다 — 캡션 없는 파일에 이름이 붙지 않는다", async () => {
    const page = notion.add(
      "root-page-id",
      "받은 노트",
      `앞 문단\n\n![그림](${signedUrl(fileId(901), "그림.png")})\n\n` +
        `<file src="${signedUrl(fileId(902), "보고서.pdf")}"></file>\n\n뒤 문단`,
    );
    expect(await orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
    const path = db.getByNotionId(page.id)!.obsidianPath;

    const pushed = await pushEdit(path, (t) => t.replace("앞 문단", "앞 문단 — 로컬에서 고침"));

    expect(pushed).toEqual([]);
    expect(mediaFileIds(path)).toEqual([fileId(901), fileId(902)]);
    expect(body(path)).toMatch(/<file src="[^"]+"><\/file>/);
  });
});
