/**
 * 페이지 · 행의 아이콘 · 커버 받기와 보내기 — 바뀐 것만 보내고, 보내지 못한 것은 알리고 넘어간다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotionClient } from "../../src/notion/client.js";
import { PageDecorations, decorationsUnchanged } from "../../src/sync/page-decorations.js";
import { setLogger } from "../../src/utils/logger.js";

function page(extra: Record<string, unknown>) {
  return { id: "p1", properties: {}, ...extra } as never;
}

describe("PageDecorations", () => {
  const warn = vi.fn();
  let notion: {
    extractIcon: NotionClient["extractIcon"];
    extractCover: NotionClient["extractCover"];
    updatePageDecorations: ReturnType<typeof vi.fn>;
    findCustomEmojiId: ReturnType<typeof vi.fn>;
  };
  let images: {
    localizeNotionFileUrl: ReturnType<typeof vi.fn>;
    uploadLocalImage: ReturnType<typeof vi.fn>;
  };
  let decorations: PageDecorations;

  beforeEach(() => {
    warn.mockReset();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    notion = {
      extractIcon: NotionClient.prototype.extractIcon,
      extractCover: NotionClient.prototype.extractCover,
      updatePageDecorations: vi.fn().mockResolvedValue(page({ last_edited_time: "t" })),
      findCustomEmojiId: vi.fn().mockResolvedValue("emoji-1"),
    };
    images = {
      localizeNotionFileUrl: vi.fn().mockResolvedValue("attachments/노트-icon.png"),
      uploadLocalImage: vi.fn().mockResolvedValue({ fileUploadId: "up-1" }),
    };
    decorations = new PageDecorations(notion as never, images as never);
  });

  describe("받기", () => {
    it("Notion 아이콘은 색까지, 올린 파일 아이콘은 내려받아 위키링크로", async () => {
      expect(
        await decorations.pulled(
          page({ icon: { type: "icon", icon: { name: "star", color: "yellow" } } }),
          "노트",
          true,
        ),
      ).toEqual({ icon: "star:yellow" });

      const uploaded = await decorations.pulled(
        page({
          icon: { type: "file", file: { url: "https://file.notion.so/f/f/i.png" } },
          cover: { type: "external", external: { url: "https://img.example/c.jpg" } },
        }),
        "노트",
        true,
      );
      expect(uploaded).toEqual({
        cover: "[[attachments/노트-icon.png]]",
        icon: "[[attachments/노트-icon.png]]",
      });
      expect(images.localizeNotionFileUrl).toHaveBeenCalledWith(
        "https://file.notion.so/f/f/i.png",
        "노트-icon",
      );
    });

    it("내려받지 않는 렌더(diff)는 주소를 그대로", async () => {
      const out = await decorations.pulled(
        page({ icon: { type: "file", file: { url: "https://file.notion.so/f/f/i.png" } } }),
        "노트",
        false,
      );
      expect(out).toEqual({ icon: "https://file.notion.so/f/f/i.png" });
      expect(images.localizeNotionFileUrl).not.toHaveBeenCalled();
    });
  });

  describe("보내기", () => {
    it("새 페이지 — 적힌 것을 모두 보낸다", async () => {
      await decorations.push("p1", "a/노트.md", { icon: "🥑", cover: "[[c.png]]" }, {});
      expect(images.uploadLocalImage).toHaveBeenCalledWith("c.png", "a");
      expect(notion.updatePageDecorations).toHaveBeenCalledWith("p1", {
        icon: { type: "emoji", emoji: "🥑" },
        cover: { type: "file_upload", file_upload: { id: "up-1" } },
      });
    });

    it("지난 사본과 같으면 보내지 않는다 — 그 사이 Notion 에서 바꾼 아이콘을 되돌리지 않게", async () => {
      const result = await decorations.push(
        "p1",
        "노트.md",
        { icon: "star:yellow" },
        { base: { icon: "star:yellow" } },
      );
      expect(result).toBeNull();
      expect(notion.updatePageDecorations).not.toHaveBeenCalled();
    });

    it("지운 것은 null 로 지운다", async () => {
      await decorations.push(
        "p1",
        "노트.md",
        { title: "x" },
        { base: { icon: "🥑", cover: "https://i.example/c" } },
      );
      expect(notion.updatePageDecorations).toHaveBeenCalledWith("p1", { icon: null, cover: null });
    });

    it("사용자 이모지는 이름으로 찾아 보내고, 없으면 알리고 넘어간다", async () => {
      await decorations.push("p1", "노트.md", { icon: ":bufo:" }, {});
      expect(notion.updatePageDecorations).toHaveBeenCalledWith("p1", {
        icon: { type: "custom_emoji", custom_emoji: { id: "emoji-1" } },
      });
      notion.findCustomEmojiId.mockResolvedValue(null);
      notion.updatePageDecorations.mockClear();
      expect(await decorations.push("p2", "노트.md", { icon: ":없음:" }, {})).toBeNull();
      expect(notion.updatePageDecorations).not.toHaveBeenCalled();
      expect(warn.mock.calls[0]![0]).toContain(":없음:");
    });

    it("Notion 이 거절한 아이콘(모르는 이름)은 알리고 넘어간다 — push 는 실패하지 않는다", async () => {
      notion.updatePageDecorations.mockRejectedValue(
        Object.assign(new Error('Invalid icon name "LiHome".'), { code: "validation_error" }),
      );
      expect(await decorations.push("p1", "노트.md", { icon: "LiHome" }, {})).toBeNull();
      expect(warn.mock.calls[0]![0]).toContain("LiHome");
    });

    it("둘을 함께 보내다 거절되면 하나씩 다시 보낸다 — 없는 아이콘 이름 때문에 커버를 잃지 않는다", async () => {
      notion.updatePageDecorations.mockImplementation(async (_id: string, body: object) => {
        if ("icon" in body) {
          throw Object.assign(new Error('Invalid icon name "없는이름".'), {
            code: "validation_error",
          });
        }
        return page({ last_edited_time: "t2" });
      });

      const written = await decorations.push(
        "p1",
        "노트.md",
        { icon: "없는이름", cover: "https://example.com/c.png" },
        {},
      );

      expect(written).toMatchObject({ last_edited_time: "t2" });
      expect(notion.updatePageDecorations.mock.calls.map(([, body]) => Object.keys(body))).toEqual([
        ["icon", "cover"],
        ["icon"],
        ["cover"],
      ]);
      expect(warn.mock.calls.map(([line]) => String(line).split(" — ")[0])).toEqual([
        "[Im-Nobsidian] Notion 이 거절한 꾸밈(아이콘 · 커버)",
        "[Im-Nobsidian] Notion 이 거절한 꾸밈(아이콘)",
      ]);
    });

    it("그 밖의 실패는 올린다", async () => {
      notion.updatePageDecorations.mockRejectedValue(new Error("network"));
      await expect(decorations.push("p1", "노트.md", { icon: "🥑" }, {})).rejects.toThrow(
        "network",
      );
    });

    it("원격을 로컬로 맞출 때는 원격과 견준다 — 올린 파일은 있는지만", async () => {
      const remote = page({
        icon: { type: "file", file: { url: "https://file.notion.so/f/f/i.png?sig=2" } },
        cover: { type: "external", external: { url: "https://img.example/old.jpg" } },
      });
      await decorations.push(
        "p1",
        "노트.md",
        { icon: "[[노트-icon.png]]", cover: "https://img.example/new.jpg" },
        { remote },
      );
      expect(notion.updatePageDecorations).toHaveBeenCalledWith("p1", {
        cover: { type: "external", external: { url: "https://img.example/new.jpg" } },
      });
    });

    it("예전 버전이 본문 속성 블록으로 보낸 아이콘 — 원격이 그대로이고 원격에 없으면 보낸다", async () => {
      await decorations.push(
        "p1",
        "노트.md",
        { icon: "🥑" },
        { base: { icon: "🥑" }, remote: page({}), remoteSettled: true },
      );
      expect(notion.updatePageDecorations).toHaveBeenCalledWith("p1", {
        icon: { type: "emoji", emoji: "🥑" },
      });
    });

    it("원격이 그 뒤 바뀌었으면(Notion 에서 지웠을 수 있다) 보내지 않는다", async () => {
      await decorations.push(
        "p1",
        "노트.md",
        { icon: "🥑" },
        { base: { icon: "🥑" }, remote: page({}), remoteSettled: false },
      );
      expect(notion.updatePageDecorations).not.toHaveBeenCalled();
    });

    it("받기 전 버전의 볼트 — 원격에 있는 아이콘을 지우거나 색을 바꾸지 않는다", async () => {
      const remote = page({ icon: { type: "icon", icon: { name: "home", color: "blue" } } });
      // 페이지: 예전 pull 은 아이콘을 적지 않았다.
      await decorations.push("p1", "노트.md", {}, { base: {}, remote, remoteSettled: true });
      // 행: 예전 pull 은 색을 뺐다.
      await decorations.push(
        "p1",
        "행.md",
        { icon: "home" },
        { base: { icon: "home" }, remote, remoteSettled: true },
      );
      expect(notion.updatePageDecorations).not.toHaveBeenCalled();
    });

    it("Notion 에 올린 파일의 서명 주소 · 읽을 수 없는 커버는 보내지 않는다", async () => {
      expect(
        await decorations.push(
          "p1",
          "노트.md",
          { icon: "https://file.notion.so/f/f/i.png?sig=3", cover: "표지" },
          {},
        ),
      ).toBeNull();
      expect(warn.mock.calls.map((c) => c[0]).join()).toContain("cover");
    });
  });

  it("decorationsUnchanged — 받은 꼴과 견준다", () => {
    const remote = page({ icon: { type: "icon", icon: { name: "star", color: "yellow" } } });
    expect(decorationsUnchanged(notion as never, remote, { icon: "star:yellow" })).toBe(true);
    expect(decorationsUnchanged(notion as never, remote, { icon: "star" })).toBe(false);
    expect(decorationsUnchanged(notion as never, page({}), { cover: "" })).toBe(true);
  });
});
