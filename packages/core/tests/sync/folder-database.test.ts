/**
 * 볼트에서 만든 노트 폴더 → Notion DB 사이드카 (#75 · ADR-037).
 * 사이드카가 생기면 다음 push 가 ADR-036 의 길로 DB 를 만든다 — 그래서 사이드카를 그 길이 읽는 대로 읽어 본다.
 */
import { describe, expect, it, vi } from "vitest";
import {
  draftFolderDatabase,
  prepareFolderDatabase,
  type FolderNote,
} from "../../src/sync/folder-database.js";
import { parseSidecarSchema, planDatabaseSchema } from "../../src/sync/database-schema.js";
import { planViews } from "../../src/sync/database-views.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import type { IStateDB } from "../../src/state/state-db-interface.js";
import { SidecarGenerator } from "../../src/view/sidecar-generator.js";

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";

const note = (name: string, frontmatter: Record<string, unknown>): FolderNote => ({
  path: `Books/${name}.md`,
  frontmatter,
});

const BOOKS: FolderNote[] = [
  note("가", {
    저자: "한강",
    상태: "읽는 중",
    별점: 4,
    완독: false,
    읽은날: new Date("2026-10-01T00:00:00Z"),
    장르: ["소설", "한국"],
    링크: "https://example.com/a",
    메모: "첫 문단, 둘째 문단",
    aliases: ["A"],
    cover: "https://example.com/c.png",
  }),
  note("나", {
    저자: "김훈",
    상태: "다 읽음",
    별점: 5,
    완독: true,
    읽은날: "2026-09-12",
    장르: ["에세이"],
    링크: "https://example.com/b",
    메모: "짧은 글",
  }),
  note("다", { 저자: "한강", 상태: "다 읽음", 별점: 3.5, 장르: [] }),
];

describe("draftFolderDatabase — frontmatter 로 속성 정하기", () => {
  it("값의 꼴로 타입을 정하고 Obsidian 의 키 · 꾸밈은 속성으로 만들지 않는다", () => {
    const draft = draftFolderDatabase({ title: "Books", databaseId: ID, notes: BOOKS });
    const types = Object.fromEntries(draft.properties.map((p) => [p.name, p.type]));
    expect(types).toEqual({
      저자: "select", // 3개가 2가지로 되풀이된다
      상태: "select",
      별점: "number",
      완독: "checkbox",
      읽은날: "date",
      장르: "multi_select",
      링크: "url",
      메모: "rich_text", // 되풀이 없음
    });
    expect(draft.sidecar.properties.find((p) => p.type === "title")?.name).toBe("Name");
    expect(draft.sidecar.properties.find((p) => p.name === "장르")?.options).toEqual([
      "소설",
      "한국",
      "에세이",
    ]);
  });

  it("Obsidian 이 정해 둔 속성 타입이 값보다 앞선다 — 별칭 타입은 속성이 아니다", () => {
    const draft = draftFolderDatabase({
      title: "Books",
      databaseId: ID,
      notes: BOOKS,
      declaredTypes: { 저자: "text", 별점: "text", 메모: "aliases", 장르: "tags" },
    });
    const types = Object.fromEntries(draft.properties.map((p) => [p.name, p.type]));
    expect(types.저자).toBe("select"); // text 는 값으로 정한다
    expect(types.장르).toBe("multi_select");
    expect(types.메모).toBeUndefined();
    expect(draft.skipped).toContainEqual({ what: "메모", reason: "Obsidian 별칭 속성이다" });
  });

  it("옵션이 될 수 없는 값(쉼표)은 글로 · 기간의 끝 키는 날짜 속성의 일부다", () => {
    const draft = draftFolderDatabase({
      title: "T",
      databaseId: ID,
      notes: [
        note("a", { 태그: ["a,b"], 기간: "2026-01-01", 기간_end: "2026-01-03" }),
        note("b", { 태그: ["c"], 기간: "2026-02-01" }),
      ],
    });
    const types = Object.fromEntries(draft.properties.map((p) => [p.name, p.type]));
    expect(types).toEqual({ 태그: "rich_text", 기간: "date" });
  });

  it("제목 속성과 같은 이름의 키는 알리고 뺀다", () => {
    const draft = draftFolderDatabase({
      title: "T",
      databaseId: ID,
      notes: [note("a", { Name: "x" })],
    });
    expect(draft.properties).toEqual([]);
    expect(draft.skipped[0]!.what).toBe("Name");
  });
});

describe("draftFolderDatabase — 사이드카를 push 가 읽는 대로", () => {
  const BASE = [
    "filters:",
    "  and:",
    '    - file.inFolder("Books")',
    "views:",
    "  - type: table",
    "    name: 전체",
    "    order:",
    "      - file.name",
    "      - note.저자",
    "      - 별점",
    "      - formula.점수",
    "    sort:",
    "      - property: 별점",
    "        direction: DESC",
    "  - type: cards",
    "    name: 표지",
    "    filters:",
    "      and:",
    "        - 완독 == true",
    "  - type: map",
    "    name: 지도",
  ].join("\n");

  it("DB 요청 · 보기 요청이 그대로 나온다 — 표 · 카드의 이름 · 열 · 정렬", () => {
    const draft = draftFolderDatabase({ title: "Books", databaseId: ID, notes: BOOKS, base: BASE });
    const schema = parseSidecarSchema(new SidecarGenerator().serialize(draft.sidecar));
    expect(schema).not.toBeNull();
    expect(schema!.databaseId).toBe(ID.replace(/-/g, ""));

    const plan = planDatabaseSchema(schema!);
    expect(plan.titleProperty).toBe("Name");
    expect(plan.initial.별점).toEqual({ number: {} });
    expect(plan.initial.상태).toEqual({
      select: { options: [{ name: "읽는 중" }, { name: "다 읽음" }] },
    });
    expect(plan.skipped).toEqual([]);

    // 새 DB 의 속성 id — Notion 이 돌려준 것처럼.
    const target = Object.fromEntries(
      schema!.properties.map((p, i) => [p.name, { id: p.type === "title" ? "title" : `n${i}` }]),
    );
    const views = planViews(schema!, target);
    expect(views.skipped).toEqual([]);
    expect(views.requests.map((r) => [r.name, r.type])).toEqual([
      ["전체", "table"],
      ["표지", "gallery"],
    ]);
    const table = views.requests[0] as unknown as {
      configuration: { properties: Array<{ property_id: string }> };
      sorts: Array<{ property: string; direction: string }>;
    };
    expect(table.configuration.properties.map((p) => p.property_id)).toEqual([
      "title",
      target.저자!.id,
      target.별점!.id,
    ]);
    expect(table.sorts).toEqual([{ property: target.별점!.id, direction: "descending" }]);

    expect(draft.views).toEqual(["전체", "표지"]);
    expect(draft.skipped.map((s) => s.what)).toEqual([
      "보기 전체 의 열",
      "보기 표지 의 필터",
      "보기 지도",
    ]);
  });

  it("읽지 못하는 .base 는 보기 없이", () => {
    const draft = draftFolderDatabase({
      title: "Books",
      databaseId: ID,
      notes: BOOKS,
      base: "views: [\n",
    });
    expect(draft.sidecar.views).toEqual([]);
    expect(draft.skipped).toContainEqual({ what: "보기", reason: ".base 를 읽지 못했다" });
  });
});

describe("prepareFolderDatabase — 볼트에 사이드카를 쓴다", () => {
  function vault(files: Record<string, string>): VaultFS {
    return {
      readFile: vi.fn(async (p: string) => {
        if (p in files) return files[p]!;
        throw new Error(`ENOENT: ${p}`);
      }),
      writeFile: vi.fn(async (p: string, c: string) => {
        files[p] = c;
      }),
      listMarkdownFiles: vi.fn(async () =>
        Object.keys(files)
          .filter((p) => p.endsWith(".md"))
          .map((path) => ({ path })),
      ),
      listNonMarkdownFiles: vi.fn(async () =>
        Object.keys(files)
          .filter((p) => !p.endsWith(".md"))
          .map((path) => ({ path })),
      ),
    } as unknown as VaultFS;
  }
  const state = (synced: string[] = []): IStateDB =>
    ({
      getByPath: (p: string) => (synced.includes(p) ? { notionPageId: "x" } : null),
    }) as unknown as IStateDB;

  it("폴더 바로 아래 노트만 행 — .base 이름이 DB 제목, types.json 을 읽는다", async () => {
    const files: Record<string, string> = {
      "Books/가.md": "---\n저자: 한강\n별점: 4\n---\n본문",
      "Books/나.md": "---\n저자: 한강\n별점: '5'\n---\n",
      "Books/하위/다.md": "---\n딴것: 1\n---\n",
      "Books/내 책장.base": "views:\n  - type: table\n    name: 표\n",
      ".obsidian/types.json": '{"types":{"별점":"number"}}',
    };
    const report = await prepareFolderDatabase(vault(files), state(), "Books/", {
      databaseId: ID,
    });
    expect(report.sidecarPath).toBe("Books/내 책장.notion.json");
    expect(report.rows).toBe(2);
    expect(report.properties.map((p) => `${p.name}:${p.type}`)).toEqual([
      "저자:select",
      "별점:number",
    ]);
    expect(report.views).toEqual(["표"]);
    const written = parseSidecarSchema(files["Books/내 책장.notion.json"]!);
    expect(written!.title).toBe("내 책장");
  });

  it("이미 사이드카가 있거나 노트가 Notion 에 올라간 폴더 · 빈 폴더는 거절한다", async () => {
    await expect(
      prepareFolderDatabase(vault({ "A/x.md": "", "A/A.notion.json": "{}" }), state(), "A", {
        databaseId: ID,
      }),
    ).rejects.toThrow("이미 DB 사이드카가 있다");
    await expect(
      prepareFolderDatabase(vault({ "A/x.md": "" }), state(["A/x.md"]), "A", { databaseId: ID }),
    ).rejects.toThrow("이미 Notion 페이지로 올라가 있다");
    await expect(
      prepareFolderDatabase(vault({ "B/x.md": "" }), state(), "A", { databaseId: ID }),
    ).rejects.toThrow("노트가 없다");
    await expect(
      prepareFolderDatabase(vault({}), state(), "/", { databaseId: ID }),
    ).rejects.toThrow("볼트 맨 위");
  });
});
