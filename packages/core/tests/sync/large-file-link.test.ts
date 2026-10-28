/**
 * 크기 상한을 넘어 받지 않은 Notion 파일 — 끊기지 않는 «Notion 에서 열기» 링크 (D4).
 *
 * 예전에는 Notion 의 서명 URL 링크만 볼트에 남았다. 그 URL 은 한 시간쯤 뒤 끊겨 볼트에서 파일을 열 길이 없었다. 이제
 * 옆에 그 페이지(블록을 알면 그 블록)의 Notion 주소를 둔다. push 는 그 링크를 떼고 서명 URL 은 파일 태그로 되돌린다 —
 * Notion 이 그 블록을 둔다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImageHandler } from "../../src/sync/image-handler.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { obsidianToNotionEnhanced } from "../../src/converter/enhanced-md-converter.js";
import {
  fileSizeLabel,
  stripLargeFileLinks,
  withLargeFileLink,
} from "../../src/converter/large-file-link.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import type { NotionClient } from "../../src/notion/client.js";

const PAGE_ID = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BLOCK_ID = "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918";
const SIGNED =
  "https://prod-files-secure.s3.us-west-2.amazonaws.com/5d2f8a41-3c7e-4b19-9e0a-7f6d2c1b8a93/" +
  "1f0e2d3c-4b5a-4968-8776-655443322110/big.zip?X-Amz-Signature=sig";
const BIG = 150 * 1024 * 1024;
const OPEN_PAGE = `[↗ Notion 에서 열기 · 150MB](https://www.notion.so/${PAGE_ID.replace(/-/g, "")})%%im-nobsidian:large-file%%`;

function internalFileUrl(name: string): string {
  const source = {
    source: `attachment:1f0e2d3c-4b5a-4968-8776-655443322110:${name}`,
    permissionRecord: { table: "block", id: BLOCK_ID, spaceId: "space" },
  };
  return `file://${encodeURIComponent(JSON.stringify(source))}`;
}

function vault(): VaultFS {
  return {
    readFile: vi.fn(),
    readBinary: vi.fn(),
    writeFile: vi.fn(),
    writeBinary: vi.fn(),
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    ensureFolder: vi.fn(),
    listMarkdownFiles: vi.fn().mockResolvedValue([]),
  };
}

describe("받지 않은 큰 파일의 «Notion 에서 열기» 링크", () => {
  let fs: VaultFS;
  let handler: ImageHandler;

  beforeEach(() => {
    fs = vault();
    // 본문은 읽지 않는다 — 크기 머리만 보고 건너뛴다.
    const download = vi.fn(
      async () => new Response("x", { status: 200, headers: { "content-length": String(BIG) } }),
    );
    const notion = { getFileBlockUrl: vi.fn(async () => SIGNED) } as unknown as NotionClient;
    handler = new ImageHandler(fs, "attachments", notion, download as never);
  });

  const pull = async (markdown: string) =>
    (await handler.downloadAllFiles(markdown, "행", PAGE_ID)).content;

  it("서명 URL 링크는 두고 옆에 끊기지 않는 페이지 주소를 둔다 — 받지 않는다", async () => {
    const content = await pull(`앞\n\n[📎 big.zip](${SIGNED})\n\n뒤`);

    expect(content).toBe(`앞\n\n[📎 big.zip](${SIGNED}) ${OPEN_PAGE}\n\n뒤`);
    expect(fs.writeBinary).not.toHaveBeenCalled();
  });

  it("블록을 아는 내부 참조는 그 블록으로 연다", async () => {
    const tag = `<file src="${internalFileUrl("big.zip")}">big.zip</file>`;
    const content = await pull(tag);

    expect(content).toBe(
      `${tag} [↗ Notion 에서 열기 · 150MB](https://www.notion.so/${PAGE_ID.replace(/-/g, "")}#${BLOCK_ID.replace(/-/g, "")})%%im-nobsidian:large-file%%`,
    );
  });

  it("볼트의 글을 그대로 둔 pull 이 다시 불러도 링크는 하나다", async () => {
    const once = await pull(`[📎 big.zip](${SIGNED})`);
    expect(await pull(once)).toBe(once);
  });

  it("어느 페이지인지 모르면 덧붙이지 않는다", async () => {
    const markdown = `[📎 big.zip](${SIGNED})`;
    expect((await handler.downloadAllFiles(markdown, "행")).content).toBe(markdown);
  });

  it("push 는 덧붙인 링크를 떼고 파일 태그로 되돌린다 — 받은 그대로 보낸 것과 같다", () => {
    const send = (note: string) =>
      obsidianToNotionEnhanced(
        createDefaultPipeline().convertToNotion(note, {
          direction: "push",
          path: "markdown-api",
          filePath: "a.md",
        }).content,
      );
    const plain = `앞\n\n[📎 big.zip](${SIGNED})\n\n뒤`;
    const withLink = `앞\n\n[📎 big.zip](${SIGNED}) ${OPEN_PAGE}\n\n뒤`;

    expect(send(withLink)).toBe(send(plain));
    expect(send(withLink)).toContain(`<file src="${SIGNED}">big.zip</file>`);
    expect(send(withLink)).not.toContain("notion.so");
  });

  it("떼기는 마커가 붙은 링크만 — 사람이 쓴 Notion 링크는 둔다", () => {
    const mine = `[내 링크](https://www.notion.so/${PAGE_ID.replace(/-/g, "")})`;
    expect(stripLargeFileLinks(`${mine} ${OPEN_PAGE}`)).toBe(mine);
    expect(withLargeFileLink("없음", "[📎 x](u)", ` ${OPEN_PAGE}`)).toBe("없음");
  });

  it("받은 뒤 변환(후처리)을 지나도 링크 그대로다 — 페이지 주소가 위키링크로 바뀌지 않는다", () => {
    // 2026-10-28 실측: 블록을 모르는 서명 URL 의 링크는 페이지 주소만 갖는다. 후처리의 Notion 링크 복원이 그것을
    // `[[↗ Notion 에서 열기 · 5KB]]` 로 바꿔 없는 노트를 가리켰고, push 가 그것을 새 문단으로 올렸다.
    const note = `앞\n\n[📎 big.zip](${SIGNED}) ${OPEN_PAGE}\n\n뒤`;
    const pulled = createDefaultPipeline().convertToMarkdown(
      note,
      { direction: "pull", path: "markdown-api", filePath: "a.md" },
      { properties: {} },
    );
    expect(pulled).toBe(note);
  });

  it("크기는 1MB 아래면 KB 로 적는다 — 상한을 낮춘 볼트", () => {
    expect(fileSizeLabel(5000)).toBe("5KB");
    expect(fileSizeLabel(100)).toBe("1KB");
    expect(fileSizeLabel(BIG)).toBe("150MB");
  });
});
