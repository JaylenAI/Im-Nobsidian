/**
 * S-05 — push 로 올린 임베드가 pull 에서 노트에 적힌 임베드로 돌아오는지 끝까지 돌린다.
 *
 * 예전에는 올린 블록의 캡션에 임베드 대상을 적어 Notion 에 `assets/a.png|설명|300` 같은 경로 ·
 * 크기가 보였고, 캡션을 고치면 pull 이 임베드를 알아보지 못해 사본을 받았다. 이제 캡션에는 설명만
 * 싣고, 어느 임베드였는지는 Notion 이 저장한 파일 id 로 적어 둔다.
 *
 * 메모리 Notion 에 미디어 블록을 더한다 — 본문의 자리표시자 줄을 quote 블록으로 보여 주고, 그 뒤에
 * 붙인 미디어 블록은 markdown API 처럼 `![캡션](서명 URL)` · `<file src="…">이름</file>` 으로
 * 싣는다(E2E r1 에서 본 모양). 실제 StateDB(임시 파일) · 메모리 볼트와 함께 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const SPACE_ID = "5d2f8a41-3c7e-4b19-9e0a-7f6d2c1b8a93";
const NOTE = "# 노트\n\n앞 문단\n\n![[assets/a.png|설명|300]]\n\n![[docs/계약서.pdf]]\n\n뒤 문단\n";

/** 자리표시자 한 줄 — push 가 본문에 심는다. */
const PLACEHOLDER_LINE = /^> (📎 .* %% im-nobsidian:local-(?:image|file):.* %%)$/u;

function signedUrl(fileId: string, name: string): string {
  return (
    `https://prod-files-secure.s3.us-west-2.amazonaws.com/${SPACE_ID}/${fileId}/` +
    `${encodeURIComponent(name)}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=sig`
  );
}

interface MediaRequest {
  readonly type: "image" | "file";
  readonly image?: MediaBody;
  readonly file?: MediaBody;
}

interface MediaBody {
  readonly file_upload: { readonly id: string };
  readonly caption: { readonly text: { readonly content: string } }[];
}

/** 메모리 Notion 에 미디어 블록을 더한다. */
function withMediaBlocks(notion: ReturnType<typeof memoryNotion>): void {
  const uploads = new Map<string, string>();
  let stored = 0;
  const childPages = notion.client.fetchAllChildren.getMockImplementation()!;

  notion.client.uploadFile.mockImplementation(async (_blob: Blob, name: string) => {
    const id = `upload-${uploads.size + 1}`;
    uploads.set(id, name);
    return id;
  });
  // 자리표시자 줄은 quote 블록이다 — 블록 id 는 `<페이지>#<줄 번호>`.
  notion.client.fetchAllChildren.mockImplementation(async (parentId: string) => {
    const lines = notion.pages.get(parentId)?.body.split("\n") ?? [];
    const quotes = lines.flatMap((line, i) => {
      const text = PLACEHOLDER_LINE.exec(line)?.[1];
      return text
        ? [
            {
              id: `${parentId}#${i}`,
              type: "quote",
              has_children: false,
              quote: { rich_text: [{ plain_text: text }] },
            },
          ]
        : [];
    });
    return [...quotes, ...(await childPages(parentId))];
  });
  // 자리표시자 뒤에 붙인 미디어 블록 — 그 줄을 Notion 이 돌려주는 모양으로 바꾼다. 자리표시자
  // 블록을 지우는 요청(deleteBlock)은 여기서 이미 끝난 셈이다.
  notion.client.appendChildBlocks.mockImplementation(
    async (parentId: string, blocks: MediaRequest[], options?: { after?: string }) => {
      const page = notion.touch(parentId);
      const lines = page.body.split("\n");
      const at = Number(options!.after!.split("#")[1]);
      const created = blocks.map((block) => {
        const body = block[block.type]!;
        const name = uploads.get(body.file_upload.id)!;
        const fileId = `00000000-0000-4000-9000-${String(++stored).padStart(12, "0")}`;
        const url = signedUrl(fileId, name);
        const caption = body.caption.map((c) => c.text.content).join("");
        lines[at] =
          block.type === "image"
            ? `![${caption.replace(/\|/g, "\\|")}](${url})`
            : `<file src="${url}">${name}</file>`;
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
}

describe("임베드 미디어 왕복(S-05)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let download: ReturnType<typeof vi.fn>;
  let orchestrator: SyncOrchestrator;
  let pageId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-media-roundtrip-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    withMediaBlocks(notion);
    download = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );

    const fs = vault.fs();
    (fs.readBinary as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const content = vault.read(path);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return Buffer.from(content);
    });
    (fs.writeBinary as ReturnType<typeof vi.fn>).mockImplementation(
      async (path: string, data: Buffer) => vault.write(path, data.toString("base64")),
    );
    orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, mediaRetryBaseMs: 0 },
      }),
      db,
      notion.client as never,
      fs,
      download as never,
    );

    vault.write("assets/a.png", "PNG");
    vault.write("docs/계약서.pdf", "PDF");
    vault.write("Note.md", NOTE);
    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    pageId = db.getByPath("Note.md")!.notionPageId!;
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Notion 에서 사람이 본문을 고친다. */
  function editInNotion(change: (body: string) => string): void {
    notion.edit(pageId, (page) => {
      page.body = change(page.body);
    });
  }

  function attachments(): string[] {
    return [...vault.files.keys()].filter((path) => path.startsWith("attachments/"));
  }

  it("Notion 캡션에는 설명만 보인다 — 경로 · 크기 · 파일 이름을 싣지 않는다", () => {
    const body = notion.pages.get(pageId)!.body;

    expect(body).toMatch(/^!\[설명\]\(https:\/\/prod-files-secure/m);
    expect(body).toMatch(/^<file src="https:\/\/prod-files-secure[^"]+">계약서\.pdf<\/file>$/m);
    expect(body).not.toContain("assets/a.png");
    expect(body).not.toContain("im-nobsidian:local-");
  });

  it("Notion 에서 다른 곳을 고쳐 받아도 임베드는 노트에 적힌 그대로 — 사본을 받지 않는다", async () => {
    editInNotion((body) => body.replace("뒤 문단", "뒤 문단 — Notion 에서 고침"));

    const pull = await orchestrator.pull();

    expect(pull).toMatchObject({ updated: 1, failed: [] });
    // 끝 줄바꿈은 메모리 Notion 이 본문을 저장하는 방식의 차이라 보지 않는다.
    expect(vault.read("Note.md")?.trimEnd()).toBe(
      NOTE.replace("뒤 문단", "뒤 문단 — Notion 에서 고침").trimEnd(),
    );
    expect(download).not.toHaveBeenCalled();
    expect(attachments()).toEqual([]);
  });

  it("Notion 에서 캡션을 고치면 그 설명으로 받는다 — 경로 · 크기는 그대로", async () => {
    editInNotion((body) => body.replace("![설명]", "![새 설명]"));

    await orchestrator.pull();

    expect(vault.read("Note.md")).toContain("![[assets/a.png|새 설명|300]]");
    expect(download).not.toHaveBeenCalled();
  });

  it("Notion 에서 캡션을 지우면 경로와 크기만 남는다", async () => {
    editInNotion((body) => body.replace("![설명]", "![]"));

    await orchestrator.pull();

    expect(vault.read("Note.md")).toContain("![[assets/a.png|300]]");
    expect(download).not.toHaveBeenCalled();
  });

  it("Notion 에서 같은 이름의 다른 파일로 바꾸면 사본을 받는다 — 옛 로컬 파일로 되돌리지 않는다", async () => {
    editInNotion((body) =>
      body.replace(
        /(!\[설명\]\(https:\/\/[^/]+\/[^/]+\/)[^/]+/,
        "$1ffffffff-0000-4000-9000-000000000099",
      ),
    );

    await orchestrator.pull();

    expect(download).toHaveBeenCalledTimes(1);
    expect(attachments()).toHaveLength(1);
    expect(vault.read("Note.md")).toContain(`![[${attachments()[0]}|설명]]`);
    expect(vault.read("assets/a.png")).toBe("PNG");
  });

  it("다시 push 해도 같은 모양으로 오간다 — 올릴 때마다 기록을 새로 적는다", async () => {
    vault.write("Note.md", NOTE.replace("앞 문단", "앞 문단 — 로컬에서 고침"));
    expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
    editInNotion((body) => body.replace("뒤 문단", "뒤 문단 — Notion 에서 고침"));

    await orchestrator.pull();

    expect(vault.read("Note.md")?.trimEnd()).toBe(
      NOTE.replace("앞 문단", "앞 문단 — 로컬에서 고침")
        .replace("뒤 문단", "뒤 문단 — Notion 에서 고침")
        .trimEnd(),
    );
    expect(download).not.toHaveBeenCalled();
  });
});
