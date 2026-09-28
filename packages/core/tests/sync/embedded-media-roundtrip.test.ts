/**
 * S-05 — push 로 올린 임베드가 pull 에서 노트에 적힌 임베드로 돌아오는지 끝까지 돌린다.
 *
 * 예전에는 올린 블록의 캡션에 임베드 대상을 적어 Notion 에 `assets/a.png|설명|300` 같은 경로 ·
 * 크기가 보였고, 캡션을 고치면 pull 이 임베드를 알아보지 못해 사본을 받았다. 이제 캡션에는 설명만
 * 싣고, 어느 임베드였는지는 Notion 이 저장한 파일 id 로 적어 둔다.
 *
 * S-19 — Notion 에서 미디어를 고치거나 지운 뒤 받으면, 보존 마커 주입기가 push 때의 자리표시자
 * 마커를 «잃은 마커» 로 보고 노트에 되살렸다. 다음 push 가 그 마커를 자리표시자로 읽어 옛 파일을
 * 한 번 더 올렸다 — 미디어가 둘이 되고, 지운 미디어가 되살아났다(E2E r2 M6 · M8). 그래서 여기서는
 * 노트를 통째로 견준다.
 *
 * 메모리 Notion 에 미디어 블록을 더한다 — 본문에서 미디어 마커가 든 줄을 블록으로 보여 주고, 그
 * 뒤에 붙인 미디어 블록은 markdown API 처럼 싣는다. 이미지는 `![캡션](서명 URL)`, 파일은
 * `<file src="file://{…attachment:<파일 id>:<이름>…}">캡션</file>` 이다(E2E r2 에서 본 모양).
 * 실제 StateDB(임시 파일) · 메모리 볼트와 함께 돌린다.
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
const IMAGE_EMBED = "![[assets/a.png|설명|300]]";
const NOTE = `# 노트\n\n앞 문단\n\n${IMAGE_EMBED}\n\n![[docs/계약서.pdf]]\n\n뒤 문단\n`;

/** 미디어 마커가 든 줄 — push 가 심은 자리표시자(`> 📎 …`)이거나, 노트에 홀로 남은 마커다. */
const MARKER_LINE = /^(?:> )?(.*%% im-nobsidian:local-(?:image|file):.* %%)$/u;

function signedUrl(fileId: string, name: string): string {
  return (
    `https://prod-files-secure.s3.us-west-2.amazonaws.com/${SPACE_ID}/${fileId}/` +
    `${encodeURIComponent(name)}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=sig`
  );
}

/** markdown API 가 파일 블록의 src 에 싣는 내부 참조. */
function internalFileUrl(fileId: string, name: string, blockId: string): string {
  const source = {
    source: `attachment:${fileId}:${name}`,
    permissionRecord: { table: "block", id: blockId, spaceId: SPACE_ID },
  };
  return `file://${encodeURIComponent(JSON.stringify(source))}`;
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

/** 메모리 Notion 에 미디어 블록을 더한다. 올린 파일 이름을 올린 순서대로 돌려준다. */
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
  // 마커가 든 줄은 블록이다 — 자리표시자는 quote, 홀로 남은 마커는 문단. 블록 id 는 `<페이지>#<줄 번호>`.
  notion.client.fetchAllChildren.mockImplementation(async (parentId: string) => {
    const lines = notion.pages.get(parentId)?.body.split("\n") ?? [];
    const markerBlocks = lines.flatMap((line, i) => {
      const text = MARKER_LINE.exec(line)?.[1];
      if (!text) return [];
      const type = line.startsWith("> ") ? "quote" : "paragraph";
      return [
        {
          id: `${parentId}#${i}`,
          type,
          has_children: false,
          [type]: { rich_text: [{ plain_text: text }] },
        },
      ];
    });
    return [...markerBlocks, ...(await childPages(parentId))];
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
        const blockId = `media-${++stored}`;
        const fileId = `00000000-0000-4000-9000-${String(stored).padStart(12, "0")}`;
        const caption = body.caption.map((c) => c.text.content).join("");
        lines[at] =
          block.type === "image"
            ? `![${caption.replace(/\|/g, "\\|")}](${signedUrl(fileId, name)})`
            : `<file src="${internalFileUrl(fileId, name, blockId)}">${caption}</file>`;
        return {
          id: blockId,
          type: block.type,
          [block.type]: { type: "file", file: { url: signedUrl(fileId, name) } },
        };
      });
      page.body = lines.join("\n");
      return created;
    },
  );
  return uploaded;
}

describe("임베드 미디어 왕복(S-05 · S-19)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let uploaded: string[];
  let download: ReturnType<typeof vi.fn>;
  let orchestrator: SyncOrchestrator;
  let pageId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-media-roundtrip-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    uploaded = withMediaBlocks(notion);
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

  /** 받은 노트 — 끝 줄바꿈은 메모리 Notion 이 본문을 저장하는 방식의 차이라 보지 않는다. */
  function note(): string | undefined {
    return vault.read("Note.md")?.trimEnd();
  }

  /** 로컬에서 글을 고쳐 본문 push 를 일으키고, 그 push 가 올린 파일 이름을 돌려준다. */
  async function pushLocalEdit(): Promise<string[]> {
    vault.write("Note.md", vault.read("Note.md")!.replace("앞 문단", "앞 문단 — 로컬에서 고침"));
    const before = uploaded.length;
    expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
    return uploaded.slice(before);
  }

  /** Notion 본문에 실린 미디어 줄. */
  function mediaLines(): string[] {
    return notion.pages
      .get(pageId)!
      .body.split("\n")
      .filter((line) => line.startsWith("![") || line.startsWith("<file"));
  }

  it("Notion 캡션에는 설명만 보인다 — 경로 · 크기 · 파일 이름을 싣지 않는다", () => {
    const body = notion.pages.get(pageId)!.body;

    expect(body).toMatch(/^!\[설명\]\(https:\/\/prod-files-secure/m);
    expect(body).toMatch(/^<file src="file:\/\/[^"]+"><\/file>$/m);
    expect(body).not.toContain("assets/a.png");
    expect(body).not.toContain("im-nobsidian:local-");
  });

  it("Notion 에서 다른 곳을 고쳐 받아도 임베드는 노트에 적힌 그대로 — 사본을 받지 않는다", async () => {
    editInNotion((body) => body.replace("뒤 문단", "뒤 문단 — Notion 에서 고침"));

    const pull = await orchestrator.pull();

    expect(pull).toMatchObject({ updated: 1, failed: [] });
    expect(note()).toBe(NOTE.replace("뒤 문단", "뒤 문단 — Notion 에서 고침").trimEnd());
    expect(download).not.toHaveBeenCalled();
    expect(attachments()).toEqual([]);
  });

  it("Notion 에서 캡션을 고치면 그 설명으로 받는다 — 경로 · 크기는 그대로", async () => {
    editInNotion((body) => body.replace("![설명]", "![새 설명]"));

    await orchestrator.pull();

    expect(note()).toBe(NOTE.replace(IMAGE_EMBED, "![[assets/a.png|새 설명|300]]").trimEnd());
    expect(download).not.toHaveBeenCalled();
  });

  it("Notion 에서 캡션을 지우면 경로와 크기만 남는다", async () => {
    editInNotion((body) => body.replace("![설명]", "![]"));

    await orchestrator.pull();

    expect(note()).toBe(NOTE.replace(IMAGE_EMBED, "![[assets/a.png|300]]").trimEnd());
    expect(download).not.toHaveBeenCalled();
  });

  it("Notion 에서 파일 블록에 캡션을 달면 그 설명으로 받는다", async () => {
    editInNotion((body) => body.replace("></file>", ">계약서 사본</file>"));

    await orchestrator.pull();

    expect(note()).toBe(
      NOTE.replace("![[docs/계약서.pdf]]", "![[docs/계약서.pdf|계약서 사본]]").trimEnd(),
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("Notion 에서 캡션을 고친 뒤 push 해도 미디어를 한 번씩만 올린다(S-19)", async () => {
    editInNotion((body) => body.replace("![설명]", "![새 설명]"));
    await orchestrator.pull();

    const pushed = await pushLocalEdit();

    expect(pushed.sort()).toEqual(["a.png", "계약서.pdf"]);
    expect(mediaLines()).toHaveLength(2);
    expect(mediaLines()[0]).toMatch(/^!\[새 설명\]\(/);
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
    expect(note()).toBe(NOTE.replace(IMAGE_EMBED, `![[${attachments()[0]}|설명]]`).trimEnd());
    expect(vault.read("assets/a.png")).toBe("PNG");
  });

  it("Notion 에서 바꾼 파일을 받은 뒤 push 해도 옛 파일을 다시 올리지 않는다(S-19)", async () => {
    editInNotion((body) =>
      body.replace(
        /(!\[설명\]\(https:\/\/[^/]+\/[^/]+\/)[^/]+/,
        "$1ffffffff-0000-4000-9000-000000000099",
      ),
    );
    await orchestrator.pull();

    const pushed = await pushLocalEdit();

    expect(pushed).not.toContain("a.png");
    expect(mediaLines()).toHaveLength(2);
  });

  it("Notion 에서 미디어를 지우면 임베드도 지운다 — 다음 push 가 되살리지 않는다(S-19)", async () => {
    editInNotion((body) =>
      body
        .split("\n")
        .filter((line) => !line.startsWith("![설명]"))
        .join("\n"),
    );

    await orchestrator.pull();

    expect(note()).not.toContain("a.png");
    expect(note()).not.toContain("im-nobsidian");
    expect(note()).toContain("![[docs/계약서.pdf]]");

    const pushed = await pushLocalEdit();

    expect(pushed).toEqual(["계약서.pdf"]);
    expect(mediaLines()).toHaveLength(1);
  });

  it("노트에 홀로 남은 미디어 마커는 올리지 않는다 — v0.3.2 의 pull 이 남긴 것(S-19)", async () => {
    vault.write(
      "Note.md",
      NOTE.replace(
        IMAGE_EMBED,
        `${IMAGE_EMBED}\n%% im-nobsidian:local-image:assets%2Fa.png%7C%EC%84%A4%EB%AA%85%7C300 %%`,
      ),
    );

    const pushed = await pushLocalEdit();

    expect(pushed.sort()).toEqual(["a.png", "계약서.pdf"]);
    expect(mediaLines()).toHaveLength(2);
    expect(notion.pages.get(pageId)!.body).not.toContain("im-nobsidian");
  });

  it("추적을 놓은 페이지를 새로 받아도 올린 미디어는 임베드로 되찾는다 — 기록은 페이지에 붙어 있다", async () => {
    // 원격 삭제 충돌을 «로컬 유지» 로 풀면 추적을 놓는다(ADR-019). 그 페이지를 Notion 휴지통에서
    // 되살리면 다음 pull 은 처음 보는 페이지로 받는다 — 올린 미디어의 기록은 남아 있다.
    db.delete(db.getByPath("Note.md")!.id);
    vault.files.delete("Note.md");
    editInNotion((body) => body.replace("뒤 문단", "뒤 문단 — Notion 에서 고침"));

    const pull = await orchestrator.pull();

    expect(pull).toMatchObject({ created: 1, failed: [] });
    expect(note()).toBe(NOTE.replace("뒤 문단", "뒤 문단 — Notion 에서 고침").trimEnd());
    expect(download).not.toHaveBeenCalled();
  });

  it("옛 push 가 올린 페이지를 처음 받으면 캡션의 대상으로 볼트 파일을 찾는다 — 사본을 받지 않는다", async () => {
    // R1 은 캡션에 임베드 대상 전체를 적었다. 기록이 없으니 캡션으로 찾는다.
    const legacy = await notion.client.createPage({
      parentId: "root-page-id",
      title: "옛 노트",
      markdown: `옛 문단\n\n![assets/a.png\\|설명\\|300](${signedUrl("0dd00000-0000-4000-9000-000000000001", "a.png")})`,
    });
    notion.edit(legacy.id, () => {});

    const pull = await orchestrator.pull();

    expect(pull).toMatchObject({ created: 1, failed: [] });
    expect(vault.read("옛 노트.md")?.trimEnd()).toBe(`옛 문단\n\n${IMAGE_EMBED}`);
    expect(download).not.toHaveBeenCalled();
  });

  it("코드 안의 임베드는 올리지 않고 글자 그대로 오간다(S-18)", async () => {
    const code =
      "# 코드\n\n형식은 `![[assets/a.png]]` 처럼 쓴다\n\n```md\n![[docs/계약서.pdf]]\n```\n\n끝 문단\n";
    vault.write("Code.md", code);
    const before = uploaded.length;

    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });

    const codePageId = db.getByPath("Code.md")!.notionPageId!;
    const body = notion.pages.get(codePageId)!.body;
    expect(uploaded.slice(before)).toEqual([]);
    expect(body).toContain("형식은 `![[assets/a.png]]` 처럼 쓴다");
    // 펜스 언어는 Notion 이름으로 올라가고, 받을 때 로컬 노트의 `md` 로 돌아온다(S-20).
    expect(body).toContain("```markdown\n![[docs/계약서.pdf]]\n```");

    notion.edit(codePageId, (page) => {
      page.body = page.body.replace("끝 문단", "끝 문단 — Notion 에서 고침");
    });
    await orchestrator.pull();

    expect(vault.read("Code.md")?.trimEnd()).toBe(
      code.replace("끝 문단", "끝 문단 — Notion 에서 고침").trimEnd(),
    );
  });

  it("다시 push 해도 같은 모양으로 오간다 — 올릴 때마다 기록을 새로 적는다", async () => {
    await pushLocalEdit();
    editInNotion((body) => body.replace("뒤 문단", "뒤 문단 — Notion 에서 고침"));

    await orchestrator.pull();

    expect(note()).toBe(
      NOTE.replace("앞 문단", "앞 문단 — 로컬에서 고침")
        .replace("뒤 문단", "뒤 문단 — Notion 에서 고침")
        .trimEnd(),
    );
    expect(download).not.toHaveBeenCalled();
  });
});
