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

  it("폴더 안 노트를 파일 이름으로 찾는다", () => {
    db.upsertWikilink({
      obsidianPath: "notes/meeting.md",
      notionPageId: "page-w1",
      title: "회의록",
      aliases: [],
    });

    expect(db.resolveWikilink("meeting")?.notionPageId).toBe("page-w1");
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
