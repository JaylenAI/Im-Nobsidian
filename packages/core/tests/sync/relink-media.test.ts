/**
 * 상태 DB 를 잃고 다시 잇는 노트의 미디어 (P7, ADR-049) — 올린 미디어 기록(`uploaded_media`)도 함께 잃어, push 가 올린
 * 그림을 사본으로 받아 노트가 달라졌다(실측 E2E: `![[img/blue.png]]` → `![[attachments/blue-<해시>.png]]` 로 충돌 ·
 * 사본 한 벌). 받은 미디어의 이름과 바이트가 노트가 가리키는 볼트 파일과 같으면 그 임베드로 되살리고 받은 것으로 적는다.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ImageHandler } from "../../src/sync/image-handler.js";
import { StateDB } from "../../src/state/state-db.js";
import { recallUploadedMedia } from "../../src/sync/uploaded-media.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";

const SPACE_ID = "5d2f8a41-3c7e-4b19-9e0a-7f6d2c1b8a93";
const FILE_ID = "00000000-0000-4000-9000-000000000001";
const URL_BLUE =
  `https://prod-files-secure.s3.us-west-2.amazonaws.com/${SPACE_ID}/${FILE_ID}/blue.png` +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=sig";
const REMOTE = `# A\n\n![](${URL_BLUE})\n`;

describe("다시 잇는 노트의 미디어 — 볼트 파일과 같으면 사본을 받지 않는다", () => {
  let tempDir: string;
  let db: StateDB;
  let files: Record<string, string>;
  let fetchFn: ReturnType<typeof vi.fn>;
  let handler: ImageHandler;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-relink-media-"));
    db = StateDB.open(join(tempDir, "state.db"));
    files = { "img/blue.png": "BLUE" };
    fetchFn = vi.fn(async () => new Response(Buffer.from("BLUE")));
    const fs = {
      readBinary: vi.fn(async (path: string) => {
        if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return Buffer.from(files[path]!);
      }),
      exists: vi.fn(async (path: string) => path in files),
    } as unknown as VaultFS;
    handler = new ImageHandler(fs, "attachments", undefined, fetchFn as never, {}, db);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("이름과 바이트가 같으면 노트의 임베드로 되살리고 받은 것으로 적는다", async () => {
    const restored = await handler.restoreUploadedMedia(
      REMOTE,
      "page-1",
      "notes/a.md",
      "# A\n\n![[img/blue.png]]\n",
    );
    expect(restored).toBe("# A\n\n![[img/blue.png]]\n");
    const known = recallUploadedMedia(db, "page-1");
    expect([...known.values()]).toEqual([
      {
        fileId: FILE_ID,
        target: "img/blue.png",
        localPath: "img/blue.png",
        fileHash: createHash("sha256").update("BLUE").digest("hex"),
      },
    ]);
  });

  it("마크다운 임베드 · 노트 폴더 옆 파일도 찾는다", async () => {
    files = { "notes/blue.png": "BLUE" };
    const restored = await handler.restoreUploadedMedia(
      REMOTE,
      "page-1",
      "notes/a.md",
      "# A\n\n![](blue.png)\n",
    );
    expect(restored).toBe("# A\n\n![[blue.png]]\n");
  });

  it("같은 이름이어도 바이트가 다르면 되살리지 않는다 — Notion 에서 바꾼 그림을 지킨다", async () => {
    files = { "img/blue.png": "OLD" };
    const restored = await handler.restoreUploadedMedia(
      REMOTE,
      "page-1",
      "notes/a.md",
      "# A\n\n![[img/blue.png]]\n",
    );
    expect(restored).toBe(REMOTE);
    expect(recallUploadedMedia(db, "page-1").size).toBe(0);
  });

  it("다시 잇는 노트가 아니면(adoptFrom 없음) 받아 보지도 않는다", async () => {
    const restored = await handler.restoreUploadedMedia(REMOTE, "page-1", "notes/a.md");
    expect(restored).toBe(REMOTE);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("노트에 같은 이름의 임베드가 없거나 받지 못하면 그대로 둔다", async () => {
    expect(
      await handler.restoreUploadedMedia(
        REMOTE,
        "page-1",
        "notes/a.md",
        "# A\n\n![[img/red.png]]\n",
      ),
    ).toBe(REMOTE);
    expect(fetchFn).not.toHaveBeenCalled();
    fetchFn.mockResolvedValueOnce(new Response("no", { status: 403 }));
    expect(
      await handler.restoreUploadedMedia(
        REMOTE,
        "page-1",
        "notes/a.md",
        "# A\n\n![[img/blue.png]]\n",
      ),
    ).toBe(REMOTE);
  });
});
