/**
 * 받은 파일 첨부의 이름 — 캡션 없는 파일은 Notion 에 올라간 이름으로 받는다.
 *
 * markdown API 는 캡션 없는 파일 블록을 `<file src="서명 URL"></file>` 로 주고, pull 변환이 자리
 * 이름을 붙인다(`[📎 file](…)`). 그 자리 이름으로 받으면 `file-<해시>` 로 저장하고 별칭을 `file`
 * 로 적는다. 예전 버전은 같은 파일을 올라간 이름으로 받았다 — 실볼트 사본(2026-10-05)에서 다시
 * 받은 행의 파일 첨부가 이름 · 별칭이 바뀌고, 같은 바이트의 사본이 새로 생겼다. 올라간 이름은
 * 서명 URL 의 경로 끝에만 있다.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ImageHandler } from "../../src/sync/image-handler.js";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import type { NotionClient } from "../../src/notion/client.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const SPACE_ID = "5d2f8a41-3c7e-4b19-9e0a-7f6d2c1b8a93";
const FILE_ID = "1f0e2d3c-4b5a-4968-8776-655443322110";
const BYTES = Buffer.from('{"cells": [], "nbformat": 4}');
const SHA12 = createHash("sha256").update(BYTES).digest("hex").slice(0, 12);

/** Notion 이 호스팅한 파일의 서명 URL — 경로 끝이 올라간 파일 이름이다. */
function signedUrl(name: string): string {
  return (
    `https://prod-files-secure.s3.us-west-2.amazonaws.com/${SPACE_ID}/${FILE_ID}/` +
    `${encodeURIComponent(name)}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=sig`
  );
}

/** markdown API 가 파일 블록의 src 에 싣는 내부 참조. */
function internalFileUrl(name: string): string {
  const source = {
    source: `attachment:${FILE_ID}:${name}`,
    permissionRecord: { table: "block", id: "block-1", spaceId: SPACE_ID },
  };
  return `file://${encodeURIComponent(JSON.stringify(source))}`;
}

function createMockVaultFs(): VaultFS {
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

describe("ImageHandler.downloadAllFiles — 받은 파일 이름", () => {
  let fs: VaultFS;
  let handler: ImageHandler;

  beforeEach(() => {
    fs = createMockVaultFs();
    const download = vi.fn(async () => new Response(BYTES, { status: 200 }));
    const notion = {
      getFileBlockUrl: vi.fn(async () => signedUrl("가격$&.pdf")),
    } as unknown as NotionClient;
    handler = new ImageHandler(fs, "attachments", notion, download as never);
  });

  async function pull(markdown: string): Promise<string> {
    return (await handler.downloadAllFiles(markdown, "행")).content;
  }

  it("캡션이 없으면 올라간 이름으로 저장하고 별칭에도 쓴다", async () => {
    const content = await pull(`앞\n\n[📎 file](${signedUrl("분석 노트.ipynb")})\n\n뒤`);

    const saved = `attachments/분석-노트.ipynb-${SHA12}.ipynb`;
    expect(content).toBe(`앞\n\n![[${saved}|분석 노트.ipynb]]\n\n뒤`);
    expect(fs.writeBinary).toHaveBeenCalledWith(saved, BYTES);
  });

  it.each([
    ["📄", "pdf", "계약서.pdf"],
    ["🎬", "video", "발표.mp4"],
    ["🔊", "audio", "녹음.m4a"],
  ])("%s %s 자리 이름도 캡션이 없는 것이다", async (emoji, placeholder, name) => {
    const content = await pull(`[${emoji} ${placeholder}](${signedUrl(name)})`);

    const ext = name.slice(name.lastIndexOf("."));
    expect(content).toBe(`![[attachments/${name}-${SHA12}${ext}|${name}]]`);
  });

  it("태그로 남은 캡션 없는 파일도 같다", async () => {
    const content = await pull(`<file src="${signedUrl("표.xlsx")}"></file>`);

    expect(content).toBe(`![[attachments/표.xlsx-${SHA12}.xlsx|표.xlsx]]`);
  });

  it("사람이 단 캡션은 예전처럼 이름 · 별칭이 된다", async () => {
    const link = await pull(`[📎 3분기 보고](${signedUrl("분석 노트.ipynb")})`);
    const tag = await pull(`<file src="${signedUrl("분석 노트.ipynb")}">3분기 보고</file>`);

    expect(link).toBe(`![[attachments/3분기-보고-${SHA12}.ipynb|3분기 보고]]`);
    expect(tag).toBe(link);
  });

  it("URL 에 이름이 없으면 예전처럼 자리 이름 · file", async () => {
    const url = `https://prod-files-secure.s3.us-west-2.amazonaws.com/${SPACE_ID}/${FILE_ID}/?sig=1`;

    const link = await pull(`[📄 pdf](${url})`);
    const tag = await pull(`<file src="${url}"></file>`);

    // 확장자는 URL 경로 · 응답 형식에서 읽는다 — 둘 다 없으면 붙이지 않는다.
    expect(link).toBe(`![[attachments/pdf-${SHA12}|pdf]]`);
    expect(tag).toBe(`![[attachments/file-${SHA12}|file]]`);
  });

  it("이름 · 캡션의 `$` 는 글자 그대로다 — 치환 패턴으로 읽지 않는다", async () => {
    const named = await pull(`[📎 file](${signedUrl("가격$&.xlsx")})`);
    const captioned = await pull(`<file src="${signedUrl("표.xlsx")}">가격 $& 표</file>`);
    const internal = await pull(`[📎 file](${internalFileUrl("가격$&.pdf")})`);
    const internalTag = await pull(`<file src="${internalFileUrl("가격$&.pdf")}"></file>`);

    expect(named).toBe(`![[attachments/가격.xlsx-${SHA12}.xlsx|가격$&.xlsx]]`);
    expect(captioned).toBe(`![[attachments/가격-표-${SHA12}.xlsx|가격 $& 표]]`);
    expect(internal).toBe(`![[attachments/가격.pdf-${SHA12}.pdf|가격$&.pdf]]`);
    expect(internalTag).toBe(internal);
  });

  it("이름의 `]]` · `|` 는 별칭에서 바꾼다 — 임베드가 깨지지 않는다", async () => {
    const content = await pull(`[📎 file](${signedUrl("초안]]최종|v2.pdf")})`);

    expect(content).toBe(`![[attachments/초안최종v2.pdf-${SHA12}.pdf|초안)최종-v2.pdf]]`);
  });
});

describe("Notion 에서 올린 캡션 없는 파일 — 다시 받아도 같은 첨부", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-pulled-file-name-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    const fs = vault.fs();
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
      (async () => new Response(BYTES, { status: 200 })) as never,
    );
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function attachments(): string[] {
    return [...vault.files.keys()].filter((path) => path.startsWith("attachments/"));
  }

  it("받은 이름 그대로 — 사본 · 이름 바뀜이 없다", async () => {
    const page = notion.add(
      "root-page-id",
      "보고서",
      `앞 문단\n\n<file src="${signedUrl("분석 노트.ipynb")}"></file>\n\n뒤 문단`,
    );
    const embed = `![[attachments/분석-노트.ipynb-${SHA12}.ipynb|분석 노트.ipynb]]`;

    expect(await orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
    const path = db.getByNotionId(page.id)!.obsidianPath;
    expect(vault.read(path)).toContain(embed);

    notion.edit(page.id, (p) => {
      p.body = p.body.replace("뒤 문단", "뒤 문단 — Notion 에서 고침");
    });
    expect(await orchestrator.pull()).toMatchObject({ updated: 1, failed: [] });

    expect(vault.read(path)).toContain(embed);
    expect(vault.read(path)).toContain("뒤 문단 — Notion 에서 고침");
    expect(attachments()).toEqual([`attachments/분석-노트.ipynb-${SHA12}.ipynb`]);
  });
});
