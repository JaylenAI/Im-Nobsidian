/**
 * P11 — 빌드한 main.js 가 Node 없이(모바일 앱) 뜨고 동기화하는가. 모바일 WebView 에는 `require` · `Buffer` ·
 * `process` 가 없고, Obsidian 은 `obsidian` · `@codemirror/*` 만 준다. 예전 main.js 는 처음에 `require("fs")` 를 불러
 * 모바일에서 아예 뜨지 않았다.
 *
 * 메모리 볼트(어댑터) · HTTP 로 받는 메모리 Notion 으로 Push → 상태 DB 를 어댑터로 씀 → 다시 불러와 Pull · Push 까지.
 */
import { describe, it, expect, beforeAll } from "vitest";
import vm from "node:vm";
import { STATE_DB_PATH as STATE_DB } from "@im-nobsidian/core";
import {
  builtMainJs,
  mobileWorld,
  type MobilePlugin,
  type MobileWorld,
} from "../helpers/mobile-host.js";
import { httpNotion } from "../helpers/http-notion.js";

const ROOT = "11111111111111111111111111111111";
const SECRET = "im-nobsidian-token";
const SETTINGS = { tokenSecret: SECRET, rootPageId: ROOT };

/** onunload 는 닫기를 기다리지 않는다 — 닫는 일이 끝날 때까지. */
async function unload(plugin: MobilePlugin): Promise<void> {
  plugin.onunload();
  await (plugin as unknown as { initializing: Promise<void> }).initializing;
}

// Notion 의 초당 요청 상한(3)을 지키므로 한 동기화가 몇 초 걸린다
describe("Node 없는 곳(모바일)의 main.js", { timeout: 30_000 }, () => {
  let mainJs: string;
  beforeAll(() => {
    mainJs = builtMainJs();
  });

  it("main.js 는 obsidian · @codemirror 밖의 모듈을 부르지 않는다", () => {
    const required = new Set([...mainJs.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]));
    for (const id of required)
      expect(id === "obsidian" || id!.startsWith("@codemirror/"), id).toBe(true);
  });

  it("뜬다 — 전역 Node 없이, Buffer 는 플러그인이 둔다", async () => {
    const notion = httpNotion(ROOT);
    const world = mobileWorld(notion.requestUrl, { [SECRET]: "ntn_fake" });
    expect(vm.runInContext("typeof require + typeof process + typeof Buffer", world.context)).toBe(
      "undefinedundefinedundefined",
    );
    const plugin = await world.load(mainJs, SETTINGS);
    await plugin.onload();
    expect(vm.runInContext("typeof Buffer.from", world.context)).toBe("function");
    expect(vm.runInContext("typeof require + typeof process", world.context)).toBe(
      "undefinedundefined",
    );
    expect(
      (plugin as unknown as { connectionStatus(): { ready: boolean } }).connectionStatus().ready,
    ).toBe(true);
    await unload(plugin);
  });

  describe("동기화", () => {
    let world: MobileWorld;
    let notion: ReturnType<typeof httpNotion>;

    beforeAll(() => {
      notion = httpNotion(ROOT);
      world = mobileWorld(notion.requestUrl, { [SECRET]: "ntn_fake" });
      world.vault.write("노트.md", "# 안녕\n본문\n");
      world.vault.write("폴더/하위.md", "하위 본문\n");
    });

    const run = async (plugin: MobilePlugin, command: string, ...args: unknown[]) => {
      await (plugin as unknown as Record<string, (...a: unknown[]) => Promise<void>>)[command]!(
        ...args,
      );
    };
    const titles = () =>
      [...notion.pages.values()]
        .filter((page) => !page.archived && page.id !== notion.root)
        .map((page) => page.title)
        .sort();

    it("Push — 페이지를 만들고 상태 DB 를 어댑터로 쓴다", async () => {
      const plugin = await world.load(mainJs, SETTINGS);
      await plugin.onload();
      await run(plugin, "executePush");
      await unload(plugin);

      expect(notion.unknown).toEqual([]);
      expect(titles()).toEqual(["노트", "폴더", "하위"]);
      expect(world.notices.some((notice) => notice.includes("생성 2"))).toBe(true);
      expect(world.vault.files.has(STATE_DB)).toBe(true);
      expect(world.vault.files.has(`${STATE_DB}.tmp`)).toBe(false);
    });

    it("앱을 가리면 상태 DB 를 바로 쓴다 — 5초 모으기를 기다리지 않는다", async () => {
      const plugin = await world.load(mainJs, SETTINGS);
      await plugin.onload();
      world.vault.write("가림.md", "가리기 전에 만든 노트\n");
      const written = () => world.vault.files.get(STATE_DB)?.mtime;
      const before = written();
      await run(plugin, "executePush");
      expect(written()).toBe(before);
      world.hide();
      for (let i = 0; i < 50 && written() === before; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(written()).not.toBe(before);
      await unload(plugin);
    });

    it("다시 불러와도 기록이 남는다 — Notion 에서 고친 것을 받고, 다시 올려도 새로 만들지 않는다", async () => {
      const plugin = await world.load(mainJs);
      await plugin.onload();
      const note = [...notion.pages.values()].find((page) => page.title === "노트")!;
      notion.edit(note.id, "# 안녕\nNotion 에서 고친 본문");
      await run(plugin, "executePull", { force: true });
      expect(world.vault.text("노트.md")).toContain("Notion 에서 고친 본문");

      world.vault.write("폴더/하위.md", "모바일에서 고친 본문\n");
      const before = notion.pages.size;
      await run(plugin, "executePush");
      await unload(plugin);

      expect(notion.unknown).toEqual([]);
      expect(notion.pages.size).toBe(before);
      expect([...notion.pages.values()].find((page) => page.title === "하위")!.markdown).toContain(
        "모바일에서 고친 본문",
      );
    });
  });
});
