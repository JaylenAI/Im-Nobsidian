// @vitest-environment happy-dom
/**
 * I9 — ListView 충실 렌더 + 클릭.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import ListView from "../../src/views/ListView.svelte";
import { renderComponent, normText, type Mounted } from "../helpers/mount-svelte.js";
import { makeViewData, SAMPLE_ENTRIES } from "../helpers/view-fixtures.js";

let m: Mounted | null = null;
afterEach(() => {
  m?.destroy();
  m = null;
});

describe("ListView (I9 마운트)", () => {
  it("엔트리마다 리스트 아이템이 누락 없이 렌더된다", () => {
    m = renderComponent(ListView, { data: makeViewData("list") });
    const items = m.target.querySelectorAll(".im-list-item");
    expect(items).toHaveLength(SAMPLE_ENTRIES.length);
    const text = normText(m.target);
    expect(text).toContain("감자");
    expect(text).toContain("당근");
    expect(text).toContain("양파");
  });

  it("아이템 클릭 시 onEntryClick 이 호출된다", () => {
    const onEntryClick = vi.fn();
    m = renderComponent(ListView, { data: makeViewData("list"), onEntryClick });
    m.target.querySelector<HTMLElement>(".im-list-item")!.click();
    expect(onEntryClick).toHaveBeenCalledTimes(1);
    expect(onEntryClick.mock.calls[0]![0]).toMatchObject({ title: "감자" });
  });

  it("빈 DB 도 크래시 없이 빈 리스트를 렌더한다", () => {
    m = renderComponent(ListView, { data: makeViewData("list", { entries: [] }) });
    expect(m.target.querySelectorAll(".im-list-item")).toHaveLength(0);
    expect(m.target.querySelector(".im-list")).not.toBeNull();
  });
});
