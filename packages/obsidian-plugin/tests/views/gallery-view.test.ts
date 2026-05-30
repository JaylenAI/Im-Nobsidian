// @vitest-environment happy-dom
/**
 * I9 — GalleryView 충실 렌더 + 커버/제목 + 클릭.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import GalleryView from "../../src/views/GalleryView.svelte";
import { renderComponent, normText, type Mounted } from "../helpers/mount-svelte.js";
import { makeViewData, SAMPLE_ENTRIES } from "../helpers/view-fixtures.js";

let m: Mounted | null = null;
afterEach(() => {
  m?.destroy();
  m = null;
});

describe("GalleryView (I9 마운트)", () => {
  it("엔트리마다 카드가 누락 없이 렌더되고 제목이 충실하다", () => {
    m = renderComponent(GalleryView, { data: makeViewData("gallery") });
    const cards = m.target.querySelectorAll(".im-gallery-card");
    expect(cards).toHaveLength(SAMPLE_ENTRIES.length);
    const titles = [...m.target.querySelectorAll(".im-gallery-card-title-text")].map((e) =>
      normText(e),
    );
    expect(titles).toEqual(["감자", "당근", "양파"]);
  });

  it("커버 이미지가 있는 엔트리는 img 로 렌더된다", () => {
    m = renderComponent(GalleryView, { data: makeViewData("gallery") });
    const imgs = m.target.querySelectorAll<HTMLImageElement>("img");
    // 감자만 cover 보유 → 최소 1개 이미지, src 에 cover URL 반영
    const srcs = [...imgs].map((i) => i.getAttribute("src") ?? "");
    expect(srcs.some((s) => s.includes("potato.png"))).toBe(true);
  });

  it("카드 클릭 시 onEntryClick 이 호출된다", () => {
    const onEntryClick = vi.fn();
    m = renderComponent(GalleryView, { data: makeViewData("gallery"), onEntryClick });
    m.target.querySelector<HTMLElement>(".im-gallery-card")!.click();
    expect(onEntryClick).toHaveBeenCalledTimes(1);
    expect(onEntryClick.mock.calls[0]![0]).toMatchObject({ title: "감자" });
  });

  it("빈 DB 도 크래시 없이 빈 갤러리를 렌더한다", () => {
    m = renderComponent(GalleryView, { data: makeViewData("gallery", { entries: [] }) });
    expect(m.target.querySelectorAll(".im-gallery-card")).toHaveLength(0);
    expect(m.target.querySelector(".im-gallery")).not.toBeNull();
  });
});
