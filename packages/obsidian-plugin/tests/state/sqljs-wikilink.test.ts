/**
 * 플러그인 상태 DB 의 위키링크 조회 — 진짜 sql.js 로 돈다.
 *
 * 파일 이름 조회는 `= ? OR LIKE ? ESCAPE` 를 쓴다. 가짜 sql.js(`mock-sqljs`)는 이 SQL 을 읽지 못해
 * 여기서 진짜로 잰다. CLI 의 `StateDB` 도 같은 조회(core `WIKILINK_LOOKUPS`)를 쓰고 같은 사례를 시험한다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqlJsStateDB } from "../../src/state/sqljs-state-db.js";

describe("SqlJsStateDB — 위키링크 조회", () => {
  let db: SqlJsStateDB;

  beforeEach(async () => {
    db = await SqlJsStateDB.open();
  });

  afterEach(async () => {
    await db.close();
  });

  it("NFD 로 친 링크 · 대소문자가 다른 링크도 찾는다 (P9 — CLI StateDB 와 같은 사례)", () => {
    db.upsertWikilink({
      obsidianPath: "회의/주간.md",
      notionPageId: "page-w",
      title: "주간 회의",
      aliases: [],
    });
    db.upsertWikilink({
      obsidianPath: "Note.md",
      notionPageId: "page-n",
      title: "Note",
      aliases: [],
    });

    expect(db.resolveWikilink("주간 회의".normalize("NFD"))?.notionPageId).toBe("page-w");
    expect(db.resolveWikilink("note")?.notionPageId).toBe("page-n");
  });

  it("대소문자를 가리지 않고 같은 경로의 기록들 — getByPathKey", () => {
    for (const obsidianPath of ["Note.md", "a/Note.md"]) {
      db.upsert({
        obsidianPath,
        notionPageId: `page-${obsidianPath}`,
        notionParentId: null,
        contentHash: "h",
        localLastModified: "2026-10-31T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
      });
    }
    expect(db.getByPathKey("NOTE.md").map((r) => r.obsidianPath)).toEqual(["Note.md"]);
    expect(db.getByPathKey("b/note.md")).toEqual([]);
  });

  it("폴더 안 노트를 파일 이름으로 찾는다", () => {
    db.upsertWikilink({
      obsidianPath: "notes/meeting.md",
      notionPageId: "page-w1",
      title: "회의록",
      aliases: [],
    });

    expect(db.resolveWikilink("meeting")?.notionPageId).toBe("page-w1");
  });

  describe("relation 대상 DB 안에서만 — resolveWikilinkIn (CLI StateDB 와 같은 사례)", () => {
    const row = (obsidianPath: string, parent: string, title: string) => {
      db.upsert({
        obsidianPath,
        notionPageId: `page-${obsidianPath}`,
        notionParentId: parent,
        contentHash: "h",
        localLastModified: "2026-10-23T00:00:00Z",
        syncDirection: "both",
        fileType: "db-row",
        status: "synced",
      });
      db.upsertWikilink({ obsidianPath, notionPageId: `page-${obsidianPath}`, title, aliases: [] });
    };
    const TARGET = "35a13b18-d382-80cf-9057-e37e6e473e41";

    it("다른 DB 의 같은 제목 행을 고르지 않는다", () => {
      row("Other/회의.md", "other-db", "회의");
      row("Target/회의.md", TARGET.replace(/-/g, ""), "회의");

      expect(db.resolveWikilinkIn("회의", [TARGET])?.obsidianPath).toBe("Target/회의.md");
      expect(db.resolveWikilinkIn("회의", ["missing-db"])).toBeNull();
      expect(db.resolveWikilinkIn("회의", [])).toBeNull();
    });

    it("파일 이름이 제목보다 먼저다 — 제목이 같은 두 행 가운데 링크가 가리키는 파일", () => {
      row("Target/회의 (a1b2c).md", TARGET, "회의");
      row("Target/회의.md", TARGET, "회의");

      expect(db.resolveWikilinkIn("회의", [TARGET])?.obsidianPath).toBe("Target/회의.md");
      expect(db.resolveWikilinkIn("회의 (a1b2c)", [TARGET])?.obsidianPath).toBe(
        "Target/회의 (a1b2c).md",
      );
    });
  });

  describe("파일 이름 조회 — 맨 위 노트 · 경로 붙은 링크 · LIKE 글자", () => {
    const entry = (obsidianPath: string, title: string, aliases: string[] = []) =>
      db.upsertWikilink({ obsidianPath, notionPageId: `page-${obsidianPath}`, title, aliases });

    it.each([
      ["볼트 맨 위 노트", "Note.md", "Note"],
      ["경로 붙은 링크", "notes/deep/Note.md", "notes/deep/Note"],
      ["폴더 안 노트의 이름만", "notes/deep/Note.md", "Note"],
    ])("%s — 제목이 파일 이름과 달라도 찾는다", (_name, path, text) => {
      entry(path, "Notion 의 다른 제목");

      expect(db.resolveWikilink(text)?.obsidianPath).toBe(path);
    });

    it("`_` 는 아무 글자가 아니다", () => {
      entry("notes/a-b.md", "AB", ["xzy"]);

      expect(db.resolveWikilink("a_b")).toBeNull();
      expect(db.resolveWikilink("x_y")).toBeNull();
    });

    it("`%` · `_` 가 든 이름 · 별칭도 그대로 찾는다", () => {
      entry("notes/50%_off.md", "할인", ["100%"]);

      expect(db.resolveWikilink("50%_off")?.title).toBe("할인");
      expect(db.resolveWikilink("100%")?.title).toBe("할인");
    });
  });
});
