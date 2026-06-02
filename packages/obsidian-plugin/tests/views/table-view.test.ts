// @vitest-environment happy-dom
/**
 * I9 — TableView 충실 렌더 + 인터랙션.
 * 동기화된 DB 데이터(행/가시 컬럼/제목)가 실제 DOM 으로 손실 없이 렌더되고,
 * 정렬·행 클릭 인터랙션이 동작하는지 마운트로 단언한다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import TableView from "../../src/views/TableView.svelte";
import { renderComponent, normText, type Mounted } from "../helpers/mount-svelte.js";
import { makeViewData, SAMPLE_ENTRIES } from "../helpers/view-fixtures.js";

let m: Mounted | null = null;
afterEach(() => {
  m?.destroy();
  m = null;
});

function titles(target: HTMLElement): string[] {
  return [...target.querySelectorAll(".im-table-row .im-table-title-text")].map((e) => normText(e));
}

describe("TableView (I9 마운트)", () => {
  it("가시 컬럼만 헤더로 렌더(visible:false 컬럼 제외)", () => {
    m = renderComponent(TableView, { data: makeViewData("table") });
    const headerText = [...m.target.querySelectorAll(".im-table-th")]
      .map((e) => normText(e))
      .join(" | ");
    expect(headerText).toContain("상태");
    expect(headerText).toContain("우선순위");
    expect(headerText).toContain("태그");
    expect(headerText).not.toContain("완료"); // visible:false
  });

  it("모든 행이 누락 없이 렌더되고 제목이 충실하다", () => {
    m = renderComponent(TableView, { data: makeViewData("table") });
    expect(m.target.querySelectorAll(".im-table-row")).toHaveLength(SAMPLE_ENTRIES.length);
    expect(titles(m.target)).toEqual(["감자", "당근", "양파"]);
  });

  it("컬럼 정렬 클릭 시 행이 재정렬된다(우선순위 오름차순)", () => {
    m = renderComponent(TableView, { data: makeViewData("table") });
    const sortBtns = m.target.querySelectorAll<HTMLButtonElement>(".im-table-sort-btn");
    // [0]=제목, [1]=상태, [2]=우선순위, [3]=태그
    sortBtns[2]!.click();
    m.flush();
    expect(titles(m.target)).toEqual(["당근", "양파", "감자"]); // 1,2,3
  });

  it("행 클릭 시 onEntryClick 이 해당 엔트리로 호출된다", () => {
    const onEntryClick = vi.fn();
    m = renderComponent(TableView, { data: makeViewData("table"), onEntryClick });
    m.target.querySelector<HTMLElement>(".im-table-row")!.click();
    expect(onEntryClick).toHaveBeenCalledTimes(1);
    expect(onEntryClick.mock.calls[0]![0]).toMatchObject({ title: "감자" });
  });

  it("빈 DB 도 헤더만 렌더하고 크래시하지 않는다", () => {
    m = renderComponent(TableView, { data: makeViewData("table", { entries: [] }) });
    expect(m.target.querySelectorAll(".im-table-row")).toHaveLength(0);
    expect(m.target.querySelector(".im-table")).not.toBeNull();
  });
});
