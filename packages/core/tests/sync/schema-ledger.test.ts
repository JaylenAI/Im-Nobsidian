import { describe, it, expect } from "vitest";
import { diffSourceSchema, seenSchemaOf, SchemaLedger } from "../../src/sync/schema-ledger.js";
import { rekeyRowFrontmatter } from "../../src/converter/frontmatter-merge.js";

describe("diffSourceSchema — 속성 id 로 견준다 (ADR-045)", () => {
  it("이름 바꿈 · 지움 · 새로 생김 · 타입 바뀜을 가른다 — 날짜는 범위 끝 키도", () => {
    const change = diffSourceSchema(
      {
        a: { name: "마감", type: "date" },
        b: { name: "메모", type: "rich_text" },
        c: { name: "점수", type: "number" },
      },
      {
        a: { name: "기한", type: "date" },
        c: { name: "점수", type: "rich_text" },
        d: { name: "두배", type: "formula" },
      },
    );
    expect([...change.renamed]).toEqual([
      ["마감", "기한"],
      ["마감_end", "기한_end"],
    ]);
    expect([...change.removed]).toEqual(["메모"]);
    expect([...change.refreshed].sort()).toEqual(["두배", "두배_end", "점수"].sort());
  });

  it("제목 속성은 보지 않는다 — 행 노트에서는 title 키다", () => {
    const seen = seenSchemaOf({
      databaseId: "db",
      title: "",
      dataSources: [{ id: "ds-1", name: "", properties: { 이름: { id: "title", type: "title" } } }],
      properties: {},
      isInline: false,
    });
    expect(seen).toEqual({ ds1: {} });
  });

  it("읽지 못한 소스는 적지 않고, 다음에 적을 때 지난번 것을 둔다", () => {
    const store = new Map<string, string>();
    const ledger = new SchemaLedger({
      getMeta: (k) => store.get(k) ?? null,
      setMeta: (k, v) => void store.set(k, v),
    });
    ledger.set("db", { s1: { a: { name: "A", type: "number" } }, s2: {} });
    ledger.set("db", { s2: { b: { name: "B", type: "number" } } });
    expect(ledger.get("db")).toEqual({
      s1: { a: { name: "A", type: "number" } },
      s2: { b: { name: "B", type: "number" } },
    });
  });
});

describe("rekeyRowFrontmatter", () => {
  const rename = (note: string, map: Record<string, string>, drop: string[] = []) =>
    rekeyRowFrontmatter(note, new Map(Object.entries(map)), (key) => drop.includes(key));

  it("값의 줄과 주석은 그대로 두고 키만 바꾼다 — 따옴표가 필요한 새 이름도", () => {
    const note = "---\n# 주석\nScore: '3' # 메모\nTags:\n  - a\n  - b\n---\n";
    expect(rename(note, { Score: "점수: 표", Tags: "태그" })).toEqual([
      "# 주석",
      "'점수: 표': '3' # 메모",
      "태그:",
      "  - a",
      "  - b",
    ]);
  });

  it("새 이름이 이미 노트에 남아 있으면 바꾸지 않는다 — 값 하나를 버리게 된다", () => {
    expect(rename("---\nA: 1\nB: 2\n---\n", { A: "B" })).toBeNull();
  });

  it("뺄 키를 빼고, 바꿀 것이 없으면 null", () => {
    expect(rename("---\nA: 1\nB: 2\n---\n", {}, ["A"])).toEqual(["B: 2"]);
    expect(rename("---\nA: 1\n---\n", { Z: "Y" })).toBeNull();
    expect(rename("본문만\n", { A: "B" })).toBeNull();
  });
});
