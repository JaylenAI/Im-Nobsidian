/**
 * P16 — 노트가 품은 폴더의 파일 왕복(ADR-056). 폴더 노트가 있는 폴더(`X/X.md`)와 노트 이름의 폴더(`N.md` 옆 `N/`)에 그냥 둔
 * 파일은 둘 곳이 없어 올리지 않고 알리기만 했다(ADR-054). 이제 그 노트의 페이지 끝에 «📁 이름» 캡션으로 붙이고, 노트 본문을
 * 바꿀 때 그 블록을 지키며, 받는 쪽은 노트에서 떼어 같은 폴더에 받는다.
 *
 * 기기 둘: 볼트 · 상태 DB 는 따로, Notion 은 하나(메모리). 파일 바이트는 메모리 Notion 이 기억해 받는 쪽 fetch 가 내려받는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-11-02";
const ROOT = "root-page-id";

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

function config(deleteSync = true, renameOnTitleChange = false): Config {
  return createConfig({
    notion: { token: "ntn_test_token", rootPageId: ROOT, parentMode: "page", databases: [] },
    sync: { ...DEFAULT_CONFIG.sync, deleteSync, renameOnTitleChange },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
  });
}

describe("노트가 품은 폴더의 파일 왕복", () => {
  let tempDir: string;
  let notion: ReturnType<typeof memoryNotion>;
  const devices: { db: StateDB; vault: MemoryVault; sync: SyncOrchestrator }[] = [];

  function device(deleteSync = true, renameOnTitleChange = false) {
    const db = StateDB.open(join(tempDir, `state-${devices.length}.db`));
    const vault = new MemoryVault();
    const fetchFn = vi.fn(async (url: string | URL) => {
      const bytes = notion.downloadOf(String(url));
      return bytes ? new Response(bytes) : new Response("gone", { status: 404 });
    });
    const sync = new SyncOrchestrator(
      config(deleteSync, renameOnTitleChange),
      db,
      notion.client as never,
      vault.fs(),
      fetchFn as unknown as typeof globalThis.fetch,
    );
    const made = { db, vault, sync };
    devices.push(made);
    return made;
  }
  const pageOf = (title: string) => [...notion.pages.values()].find((p) => p.title === title)!;
  const uploads = () => notion.client.uploadFile.mock.calls.length;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-folder-note-files-"));
    notion = memoryNotion({ minuteClock: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const made of devices.splice(0)) made.db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** 기기 A 가 폴더 노트 · 노트 이름의 폴더에 파일을 두고 올린다. */
  async function seeded() {
    const a = device();
    at("10:00:05");
    a.vault.write("X/X.md", "폴더 노트 글\n");
    a.vault.write("X/Y.md", "하위 노트\n");
    a.vault.write("X/data.csv", "a,b\n1,2\n");
    a.vault.write("N.md", "노트 글\n");
    a.vault.write("N/M.md", "노트의 하위\n");
    a.vault.write("N/sheet.csv", "x\n");
    const pushed = await a.sync.push();
    expect(pushed.failed).toEqual([]);
    return a;
  }

  it("push: 노트의 페이지 끝에 «📁 이름» 으로 붙이고, 노트 본문을 다시 보내도 그 블록을 지킨다", async () => {
    const a = await seeded();
    expect(pageOf("X").body).toMatch(/<file src="[^"]*\/data\.csv\?[^"]*">📁 data\.csv<\/file>$/);
    expect(pageOf("N").body).toMatch(/📁 sheet\.csv<\/file>$/);
    expect(uploads()).toBe(2);

    at("10:02:05");
    a.vault.write("X/X.md", "폴더 노트 글 고침\n");
    expect(await a.sync.push()).toMatchObject({ updated: 1, failed: [] });
    expect(pageOf("X").body).toContain("폴더 노트 글 고침");
    expect(pageOf("X").body).toContain("📁 data.csv");
    expect(uploads()).toBe(2);
  });

  it("pull: 다른 볼트가 노트에서 떼어 같은 폴더에 같은 바이트로 받고, 다시 돌려도 바뀌는 것이 없다", async () => {
    const a = await seeded();
    at("10:03:05");
    const b = device();
    await b.sync.pull();

    // 하위 페이지는 예전처럼 링크로 받는다 — 폴더 첨부만 노트에서 빠진다
    expect(b.vault.read("X/X.md")).toBe("폴더 노트 글\n\n[[Y]]");
    // 하위가 있는 노트 페이지는 받는 쪽에서 폴더 노트가 된다(예전 규칙) — 파일은 같은 폴더 N 에 든다
    expect(b.vault.read("N/N.md")).toBe("노트 글\n\n[[M]]");
    expect(b.vault.read("X/data.csv")).toBe("a,b\n1,2\n");
    expect(b.vault.read("N/sheet.csv")).toBe("x\n");
    // 받은 그림 폴더에 사본이 생기지 않는다
    expect([...b.vault.files.keys()].filter((p) => p.endsWith(".csv")).sort()).toEqual([
      "N/sheet.csv",
      "X/data.csv",
    ]);

    at("10:05:05");
    const before = uploads();
    expect(await b.sync.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
    expect(uploads()).toBe(before);
    expect(await b.sync.pull()).toMatchObject({ created: 0, updated: 0 });
    expect(await a.sync.pull()).toMatchObject({ created: 0, updated: 0 });
    expect([...a.vault.files.keys()].filter((p) => p.endsWith(".csv")).sort()).toEqual([
      "N/sheet.csv",
      "X/data.csv",
    ]);
  });

  it("바꾼 파일은 새 블록으로 바꿔 올리고, 받는 쪽이 새 내용으로 덮는다", async () => {
    const a = await seeded();
    at("10:03:05");
    const b = device();
    await b.sync.pull();

    at("10:05:05");
    a.vault.write("X/data.csv", "a,b\n3,4\n");
    expect((await a.sync.push()).failed).toEqual([]);
    expect(pageOf("X").body.match(/📁 data\.csv/g)).toHaveLength(1);

    at("10:07:05");
    await b.sync.pull();
    expect(b.vault.read("X/data.csv")).toBe("a,b\n3,4\n");
  });

  it("지운 파일(deleteSync)은 Notion 블록을 지우고, 받는 쪽도 지운다 — 노트 글은 그대로", async () => {
    const a = await seeded();
    at("10:03:05");
    const b = device();
    await b.sync.pull();

    at("10:05:05");
    a.vault.files.delete("N/sheet.csv");
    expect((await a.sync.push()).failed).toEqual([]);
    expect(pageOf("N").body).not.toContain("sheet.csv");
    expect(pageOf("N").body).toContain("노트 글");

    at("10:07:05");
    await b.sync.pull();
    expect(b.vault.read("N/sheet.csv")).toBeUndefined();
    expect(b.vault.read("N/N.md")).toBe("노트 글\n\n[[M]]");
  });

  it("Notion 에서 노트 끝에 글을 더 써도 폴더 첨부는 노트로 새지 않고, 다시 올려도 블록을 지킨다", async () => {
    const a = await seeded();
    at("10:03:05");
    notion.edit(pageOf("X").id, (page) => {
      page.body = page.body.replace("폴더 노트 글", "폴더 노트 글\n\nNotion 에서 더함");
    });

    at("10:05:05");
    await a.sync.pull();
    expect(a.vault.read("X/X.md")).toContain("Notion 에서 더함");
    expect(a.vault.read("X/X.md")).not.toContain("data.csv");

    at("10:07:05");
    a.vault.write("X/X.md", `${a.vault.read("X/X.md")}로컬에서 더함\n`);
    expect((await a.sync.push()).failed).toEqual([]);
    expect(pageOf("X").body).toContain("로컬에서 더함");
    expect(pageOf("X").body).toMatch(/📁 data\.csv<\/file>$/);
  });

  it("Notion 에서 페이지 맨 아래(폴더 첨부 뒤)에 글을 써도 — 받는 볼트 둘 다 파일을 노트로 들이지 않고, 다음 push 가 파일을 끝으로 옮긴다", async () => {
    const a = await seeded();
    at("10:03:05");
    notion.edit(pageOf("X").id, (page) => {
      page.body = `${page.body}\n맨 아래에 쓴 글`;
    });

    at("10:05:05");
    const b = device();
    await b.sync.pull();
    await a.sync.pull();
    for (const vault of [a.vault, b.vault]) {
      expect(vault.read("X/X.md")).toContain("맨 아래에 쓴 글");
      expect(vault.read("X/X.md")).not.toContain("data.csv");
      expect(vault.read("X/data.csv")).toBe("a,b\n1,2\n");
    }

    at("10:07:05");
    const before = uploads();
    b.vault.write("X/X.md", `${b.vault.read("X/X.md")}\nB 가 더함\n`);
    expect((await b.sync.push()).failed).toEqual([]);
    expect(uploads()).toBe(before);
    expect(pageOf("X").body).toMatch(/B 가 더함[\s\S]*📁 data\.csv<\/file>$/);
  });

  it("두 볼트가 같은 폴더 첨부를 따로 고쳐 올려도 블록은 하나다 — 나중에 올린 것이 남고, 다른 볼트가 받는다", async () => {
    const a = await seeded();
    at("10:03:05");
    const b = device();
    await b.sync.pull();

    at("10:05:05");
    a.vault.write("X/data.csv", "a,b\nA,A,A\n");
    expect((await a.sync.push()).failed).toEqual([]);
    b.vault.write("X/data.csv", "a,b\nB,B,B,B\n");
    expect((await b.sync.push()).failed).toEqual([]);
    expect(pageOf("X").body.match(/📁 data\.csv/g)).toHaveLength(1);

    at("10:07:05");
    await a.sync.pull();
    expect(a.vault.read("X/data.csv")).toBe("a,b\nB,B,B,B\n");
    expect(a.vault.read("X/X.md")).not.toContain("data.csv");
  });

  for (const deleteSync of [true, false]) {
    it(`폴더 이름을 바꿔도(deleteSync ${deleteSync}) 파일 블록은 하나씩 · 다른 볼트는 새 폴더에만 받는다`, async () => {
      const a = device(deleteSync);
      at("10:00:05");
      a.vault.write("X/X.md", "폴더 노트 글\n");
      a.vault.write("X/Y.md", "하위\n");
      a.vault.write("X/data.csv", "a,b\n1,2\n");
      a.vault.write("N.md", "노트 글\n");
      a.vault.write("N/sheet.csv", "x\n");
      a.vault.write("P/p.csv", "p\n");
      expect((await a.sync.push()).failed).toEqual([]);
      at("10:02:05");
      const early = device(deleteSync);
      await early.sync.pull();

      at("10:03:05");
      a.vault.renameFolder("X", "W");
      a.vault.rename("W/X.md", "W/W.md");
      a.vault.rename("N.md", "K.md");
      a.vault.renameFolder("N", "K");
      a.vault.renameFolder("P", "Q");
      expect((await a.sync.push()).failed).toEqual([]);
      const body = (title: string) => pageOf(title).body;
      expect(body("W").match(/📁 data\.csv/g)).toHaveLength(1);
      expect(body("K").match(/📁 sheet\.csv/g)).toHaveLength(1);
      expect(body("Q").match(/📁 p\.csv/g)).toHaveLength(1);
      const before = uploads();
      expect((await a.sync.push()).failed).toEqual([]);
      expect(uploads()).toBe(before);

      at("10:05:05");
      const b = device(deleteSync);
      await b.sync.pull();
      const files = [...b.vault.files.keys()].filter((path) => !path.endsWith(".md")).sort();
      expect(files).toEqual(["K/sheet.csv", "Q/p.csv", "W/data.csv"]);

      // 옮기기 전에 받은 볼트 — Notion 의 이름 바꾸기를 따르지 않는 설정이라 옛 자리에 두고, 다시 올리지도 사본을 받지도 않는다
      await early.sync.pull();
      const kept = [...early.vault.files.keys()].filter((path) => !path.endsWith(".md")).sort();
      expect(kept).toEqual(["N/sheet.csv", "P/p.csv", "X/data.csv"]);
      at("10:07:05");
      const quiet = uploads();
      expect(await early.sync.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
      expect(uploads()).toBe(quiet);
      expect(body("W").match(/📁 data\.csv/g)).toHaveLength(1);
    });
  }

  it("Notion 의 이름 바꾸기를 따르는 볼트는 폴더째 옮겨 받고, 다시 올리지 않는다", async () => {
    const a = device();
    at("10:00:05");
    a.vault.write("X/X.md", "폴더 노트 글\n");
    a.vault.write("X/Y.md", "하위\n");
    a.vault.write("X/data.csv", "a,b\n1,2\n");
    a.vault.write("N.md", "노트 글\n");
    a.vault.write("N/sheet.csv", "x\n");
    expect((await a.sync.push()).failed).toEqual([]);
    at("10:02:05");
    const b = device(true, true);
    await b.sync.pull();

    at("10:03:05");
    a.vault.renameFolder("X", "W");
    a.vault.rename("W/X.md", "W/W.md");
    a.vault.rename("N.md", "K.md");
    a.vault.renameFolder("N", "K");
    expect((await a.sync.push()).failed).toEqual([]);

    at("10:05:05");
    await b.sync.pull();
    const files = [...b.vault.files.keys()].sort();
    expect(files.filter((path) => !path.endsWith(".md"))).toEqual(["K/sheet.csv", "W/data.csv"]);
    at("10:07:05");
    const quiet = uploads();
    expect(await b.sync.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
    expect(uploads()).toBe(quiet);
    expect(pageOf("W").body.match(/📁 data\.csv/g)).toHaveLength(1);
  });

  it("하위가 없는 노트 이름의 폴더 · 폴더 노트 하나뿐인 폴더도 파일을 왕복한다 — 다시 돌려도 올리거나 받는 것이 없다", async () => {
    const a = device();
    at("10:00:05");
    a.vault.write("S.md", "노트만\n");
    a.vault.write("S/only.csv", "s\n");
    a.vault.write("Z/Z.md", "폴더 노트 하나\n");
    a.vault.write("Z/z.csv", "z\n");
    expect((await a.sync.push()).failed).toEqual([]);
    expect(pageOf("S").body).toMatch(/📁 only\.csv<\/file>$/);
    expect(pageOf("Z").body).toMatch(/📁 z\.csv<\/file>$/);

    at("10:03:05");
    const b = device();
    await b.sync.pull();
    // 끝 줄바꿈은 파일이 없는 노트를 받을 때와 같다
    expect(b.vault.read("S.md")?.trimEnd()).toBe("노트만");
    expect(b.vault.read("S/only.csv")).toBe("s\n");
    // 하위가 없는 페이지는 노트로 받는다(Notion 모델 — 폴더 노트 하나뿐인 폴더) — 파일은 그 이름의 폴더에
    expect(b.vault.read("Z.md")?.trimEnd()).toBe("폴더 노트 하나");
    expect(b.vault.read("Z/z.csv")).toBe("z\n");

    at("10:05:05");
    const before = uploads();
    expect(await b.sync.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
    expect(uploads()).toBe(before);
    expect(await a.sync.pull()).toMatchObject({ created: 0, updated: 0 });
    expect(await b.sync.pull()).toMatchObject({ created: 0, updated: 0 });
  });

  it("v0.3 의 push 가 캡션 = 이름으로 올린 노트 끝의 임베드는 노트에 남는다 — 폴더 첨부로 떼지 않는다", async () => {
    const root = notion.add(ROOT, "Old", "");
    notion.add(root.id, "Child", "하위");
    const fileUrl =
      "https://prod-files-secure.s3.us-west-2.amazonaws.com/s/0123abcd-0000-4000-8000-00000000000e/old.csv?X-Amz=1";
    notion.edit(root.id, (page) => {
      page.body = `옛 노트\n<file src="${fileUrl}">old.csv</file>`;
    });
    at("10:03:05");
    const b = device();
    await b.sync.pull();
    expect(b.vault.read("Old/Old.md")).toContain("old.csv");
    expect(b.vault.read("Old/old.csv")).toBeUndefined();
  });
});
