import { describe, it, expect } from "vitest";
import {
  readDesignLine,
  hasDesignMarker,
  parseDesignColor,
  type DesignLine,
} from "../../src/converter/design-markers.js";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";

/** 조각을 `글[서식]` 꼴로 — 서식이 없으면 글만. */
function show(line: DesignLine): string[] {
  return line.segments.map((s) => {
    const styles = s.styles.map((st) =>
      st.kind === "color" ? `${st.color.name}${st.color.background ? "_bg" : ""}` : st.kind,
    );
    return styles.length ? `${s.text}[${styles.join("+")}]` : s.text;
  });
}

/** 줄에서 마커 자리를 지운 글 — 편집 화면이 숨긴 뒤 보이는 글. */
function hidden(text: string, line: DesignLine): string {
  let out = "";
  let at = 0;
  for (const m of [...line.markers].sort((a, b) => a.from - b.from)) {
    out += text.slice(at, m.from);
    at = m.to;
  }
  return out + text.slice(at);
}

describe("parseDesignColor", () => {
  it("글자색 · 두 가지 배경 표기를 같은 색으로 읽고, default · 모르는 색은 칠하지 않는다", () => {
    expect(parseDesignColor("red")).toEqual({ name: "red", background: false });
    expect(parseDesignColor("red_bg")).toEqual({ name: "red", background: true });
    expect(parseDesignColor("purple_background")).toEqual({ name: "purple", background: true });
    expect(parseDesignColor("default")).toBeUndefined();
    expect(parseDesignColor("teal")).toBeUndefined();
    expect(parseDesignColor(undefined)).toBeUndefined();
  });
});

describe("readDesignLine", () => {
  it("글자색 짝 — 두 마커를 숨기고 사이 글을 칠한다", () => {
    const text = "A1 %%im-nobsidian:color:red%%빨간 글자%%/color%% 와 기본 글자";
    const line = readDesignLine(text);

    expect(show(line)).toEqual(["A1 ", "빨간 글자[red]", " 와 기본 글자"]);
    expect(hidden(text, line)).toBe("A1 빨간 글자 와 기본 글자");
    expect(line.styled).toEqual([
      { from: 29, to: 34, style: { kind: "color", color: { name: "red", background: false } } },
    ]);
  });

  it("겹친 짝 — 색 안의 밑줄은 두 서식을 함께 건다", () => {
    const line = readDesignLine(
      "%%im-nobsidian:color:red%%%%im-nobsidian:underline%%**굵게**%%/underline%%%%/color%% 끝",
    );
    expect(show(line)).toEqual(["**굵게**[red+underline]", " 끝"]);
  });

  it("같은 글이 여러 번 나와도 조각 차례로 어느 것이 칠해지는지 가린다", () => {
    const line = readDesignLine(
      "같은 글 %%im-nobsidian:color:red%%반복%%/color%% 반복 %%im-nobsidian:color:blue%%반복%%/color%%",
    );
    expect(show(line)).toEqual(["같은 글 ", "반복[red]", " 반복 ", "반복[blue]"]);
  });

  it("멘션 짝 — 보이는 글을 멘션으로 칠하고 속성 마커는 숨긴다", () => {
    const text =
      "사용자: %%im-nobsidian:mention-user:url=user%3A%2F%2F2e6d%%@봇%%/mention%% · 날짜 %%im-nobsidian:mention-date:start=2026-09-26&startTime=09%3A00%%2026-09-26 09:00%%/mention%%";
    const line = readDesignLine(text);
    expect(show(line)).toEqual([
      "사용자: ",
      "@봇[mention]",
      " · 날짜 ",
      "2026-09-26 09:00[mention]",
    ]);
    expect(hidden(text, line)).toBe("사용자: @봇 · 날짜 2026-09-26 09:00");
  });

  it("블록 색 · 콜아웃 스타일 · 토글 색 — 줄 전체에 걸리는 것을 따로 돌려준다", () => {
    expect(readDesignLine("문단 %%im-nobsidian:block-color:purple_bg%%").blockColor).toEqual({
      name: "purple",
      background: true,
    });
    expect(
      readDesignLine(
        "> [!note] 로켓 %%im-nobsidian:callout-style:icon=%F0%9F%9A%80&color=blue_bg%%",
      ).callout,
    ).toEqual({ icon: "🚀", color: { name: "blue", background: true } });
    // 아이콘 없는 콜아웃 — Notion 에서 아이콘을 지운 것이다(null). 토글은 아이콘을 싣지 않는다.
    expect(readDesignLine("> [!note] 아이콘 없음 %%im-nobsidian:callout-style:%%").callout).toEqual(
      {
        color: undefined,
        icon: null,
      },
    );
    expect(
      readDesignLine("> [!toggle]- 초록 %%im-nobsidian:toggle-color:green_bg%%").callout,
    ).toEqual({ color: { name: "green", background: true } });
  });

  it("표 줄 — 표 · 행 · 셀 · 열 속성을 셀 번호와 함께 읽는다", () => {
    const head = readDesignLine(
      "| %%im-nobsidian:table:header-row=true&header-column=true%%%%im-nobsidian:table-row:color=blue_bg%%항목 | %%im-nobsidian:table-col:width=120&color=red%%값 |",
    );
    expect(head.table).toEqual({
      headerRow: true,
      headerColumn: true,
      rowColor: { name: "blue", background: true },
      cellColors: new Map(),
      columnColors: new Map([[1, { name: "red", background: false }]]),
    });

    const row = readDesignLine(
      "> | **굵게** | %%im-nobsidian:table-cell:color=red_bg%%%%im-nobsidian:color:red%%빨강%%/color%% | `a|b` |",
    );
    expect(row.table?.cellColors).toEqual(new Map([[1, { name: "red", background: true }]]));
    expect(show(row)).toEqual(["> | **굵게** | ", "빨강[red]", " | `a|b` |"]);

    // 이스케이프한 파이프는 칸을 나누지 않는다 — 셀 색이 옆 칸으로 밀리면 안 된다
    const escaped = readDesignLine("| a \\| b | %%im-nobsidian:table-cell:color=green%%c |");
    expect(escaped.table?.cellColors).toEqual(new Map([[1, { name: "green", background: false }]]));
  });

  it("인라인 코드 안의 마커 모양 글은 사용자가 적은 글자다 — 숨기지도 칠하지도 않는다", () => {
    const text =
      "앞 `%%im-nobsidian:color:red%%그대로%%/color%%` 뒤 %%im-nobsidian:color:red%%빨강%%/color%%";
    const line = readDesignLine(text);
    expect(show(line)).toEqual([
      "앞 `%%im-nobsidian:color:red%%그대로%%/color%%` 뒤 ",
      "빨강[red]",
    ]);
    expect(hasDesignMarker("`%%im-nobsidian:color:red%%`")).toBe(true); // 빠른 거르기는 넓게 본다
  });

  it("짝 없는 닫는 토큰은 우리 것이 아니라 그대로 두고, 모르는 색은 짝만 맞춰 숨긴다", () => {
    const text = "a %%/color%% b %%im-nobsidian:color:teal%%c%%/color%%";
    const line = readDesignLine(text);
    expect(hidden(text, line)).toBe("a %%/color%% b c");
    expect(line.styled).toEqual([]);
  });

  it("공백형 · 서식과 무관한 마커도 숨긴다 — 읽기 보기에서처럼 보이지 않게", () => {
    const text =
      "**DB** *(Notion DB)*%%im-nobsidian:child-database:id=abc&title=DB%% %% im-nobsidian:inline-db:x %%";
    expect(hidden(text, readDesignLine(text))).toBe("**DB** *(Notion DB)* ");
    expect(readDesignLine("마커 없음").segments).toEqual([
      { from: 0, to: 5, text: "마커 없음", styles: [] },
    ]);
  });
});

describe("readDesignLine · pull 산출물과 맞물림", () => {
  // 읽기는 쓰기(pull 변환기)의 모양을 따라야 한다 — 쓰기가 바뀌면 여기가 깨진다.
  const nfm = [
    '<span color="red" underline="true">**굵게+빨강+밑줄**</span> · <span color="yellow_bg">노랑</span>',
    '보라 문단 {color="purple_bg"}',
    '<callout icon="🚀" color="blue_bg">',
    "\t로켓",
    "</callout>",
    '<details color="green_bg">',
    "<summary>토글</summary>",
    "\t안",
    "</details>",
    '<table header-row="true" header-column="true">',
    '<tr color="blue_bg">',
    "<td>항목</td>",
    "<td>값</td>",
    "</tr>",
    "<tr>",
    "<td>a</td>",
    '<td color="red_bg"><span color="red">빨강</span></td>',
    "</tr>",
    "</table>",
    '<mention-date start="2026-09-26" startTime="09:00" timeZone="Etc/GMT-9"/>',
  ].join("\n");
  const lines = notionEnhancedToObsidian(nfm).split("\n").map(readDesignLine);
  const find = (pred: (l: DesignLine) => boolean): DesignLine => lines.find(pred)!;

  it("글자색 · 밑줄 · 배경 글자", () => {
    const line = find((l) => l.styled.length > 0 && l.segments[0]!.styles.length > 0);
    expect(show(line)).toEqual(["**굵게+빨강+밑줄**[red+underline]", " · ", "노랑[yellow_bg]"]);
  });

  it("블록 색 · 콜아웃 · 토글", () => {
    expect(find((l) => l.blockColor !== undefined).blockColor).toEqual({
      name: "purple",
      background: true,
    });
    const callouts = lines.filter((l) => l.callout).map((l) => l.callout);
    expect(callouts).toEqual([
      { icon: "🚀", color: { name: "blue", background: true } },
      { color: { name: "green", background: true } },
    ]);
  });

  it("표 · 멘션", () => {
    const tables = lines.filter((l) => l.table).map((l) => l.table!);
    expect(tables[0]).toMatchObject({
      headerRow: true,
      headerColumn: true,
      rowColor: { name: "blue" },
    });
    expect(tables[1]!.cellColors.get(1)).toEqual({ name: "red", background: true });
    expect(lines.some((l) => l.styled.some((s) => s.style.kind === "mention"))).toBe(true);
  });
});
