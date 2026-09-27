/**
 * S-04 — 볼트 폴더가 Notion 에서 무엇인가. 폴더 노트 · push 가 만든 폴더 페이지 · DB 폴더 ·
 * DB 를 품은 페이지의 폴더를 가르는 규칙.
 */
import { describe, it, expect } from "vitest";
import {
  ancestorFolders,
  databaseFolderIndex,
  enclosingDatabaseFolder,
  folderContainer,
  isFolderNotePath,
  isFolderRecord,
  parentFolderOf,
  type FolderLookup,
} from "../../src/sync/folder-container.js";

/** 추적 레코드 경로 → 페이지 id, DB 폴더 → DB id. */
function lookup(pages: Record<string, string>, databases: Record<string, string>): FolderLookup {
  return {
    databaseAt: (folder) => databases[folder] ?? null,
    pageIdAt: (path) => pages[path] ?? null,
  };
}

describe("parentFolderOf · ancestorFolders", () => {
  it("볼트 루트의 파일은 부모 폴더가 없다", () => {
    expect(parentFolderOf("노트.md")).toBe("");
    expect(ancestorFolders("노트.md")).toEqual([]);
  });

  it("얕은 폴더부터 모든 조상을 돌려준다", () => {
    expect(parentFolderOf("A/B/c.md")).toBe("A/B");
    expect(ancestorFolders("A/B/c.md")).toEqual(["A", "A/B"]);
  });
});

describe("isFolderNotePath · isFolderRecord", () => {
  it("파일 이름이 든 폴더 이름과 같으면 폴더 노트다", () => {
    expect(isFolderNotePath("A/B/B.md")).toBe(true);
    expect(isFolderNotePath("A/B/c.md")).toBe(false);
    // 볼트 루트의 파일은 든 폴더가 없다.
    expect(isFolderNotePath("A.md")).toBe(false);
  });

  it("폴더를 추적하는 레코드는 경로가 .md 가 아닌 폴더 레코드뿐이다", () => {
    expect(isFolderRecord({ fileType: "folder-note", obsidianPath: "Docs" })).toBe(true);
    expect(isFolderRecord({ fileType: "folder-only", obsidianPath: "A/B" })).toBe(true);
    // 폴더 노트 파일은 파일이다 — 사라지면 파일 목록으로 안다.
    expect(isFolderRecord({ fileType: "folder-note", obsidianPath: "A/A.md" })).toBe(false);
    expect(isFolderRecord({ fileType: "file", obsidianPath: "Docs" })).toBe(false);
  });
});

describe("databaseFolderIndex", () => {
  it("설정 폴더의 끝 슬래시를 떼고 같은 폴더로 본다", () => {
    const index = databaseFolderIndex([
      { databaseId: "db-1", localFolder: "Projects/Tasks/" },
      { databaseId: "db-2", localFolder: "Home/과제" },
    ]);
    expect(index.get("Projects/Tasks")).toBe("db-1");
    expect(index.get("Home/과제")).toBe("db-2");
  });

  it("같은 폴더를 둘이 가리키면 먼저 적힌 것이 주인이다 — 설정이 자동 발견보다 앞선다", () => {
    const index = databaseFolderIndex([
      { databaseId: "configured", localFolder: "Tasks" },
      { databaseId: "discovered", localFolder: "Tasks" },
    ]);
    expect(index.get("Tasks")).toBe("configured");
  });
});

describe("folderContainer", () => {
  it("DB 폴더는 DB 다 — 같은 이름의 폴더 노트 · 폴더 레코드가 있어도", () => {
    const l = lookup(
      { "Home/과제/과제.md": "row-same-name", "Home/과제": "page-bogus" },
      { "Home/과제": "db-tasks" },
    );
    expect(folderContainer("Home/과제", l)).toEqual({ kind: "database", databaseId: "db-tasks" });
  });

  it("폴더 노트가 폴더의 페이지다", () => {
    const l = lookup({ "Home/Home.md": "page-home", "Home.md": "page-sibling" }, {});
    expect(folderContainer("Home", l)).toEqual({ kind: "page", pageId: "page-home" });
  });

  it("폴더 노트가 없으면 push 가 만든 폴더 페이지", () => {
    const l = lookup({ Docs: "page-docs" }, {});
    expect(folderContainer("Docs", l)).toEqual({ kind: "page", pageId: "page-docs" });
  });

  it("DB 를 품은 페이지(`계획.md`)의 폴더 `계획/` 은 그 페이지다", () => {
    const l = lookup({ "Notes/계획.md": "page-plan" }, {});
    expect(folderContainer("Notes/계획", l)).toEqual({ kind: "page", pageId: "page-plan" });
  });

  it("행 이름의 폴더는 그 행(페이지)이다", () => {
    const l = lookup({ "Home/과제/과제 A.md": "row-a" }, { "Home/과제": "db-tasks" });
    expect(folderContainer("Home/과제/과제 A", l)).toEqual({ kind: "page", pageId: "row-a" });
  });

  it("아무 자리도 없으면 null", () => {
    expect(folderContainer("새 폴더", lookup({}, {}))).toBeNull();
  });
});

describe("enclosingDatabaseFolder — 페이지로 만들 자리가 없는 폴더", () => {
  const l = lookup(
    { "Home/Home.md": "page-home", "Home/과제/과제 A.md": "row-a" },
    { "Home/과제": "db-tasks" },
  );

  it("DB 폴더 바로 아래의 행 이름이 아닌 폴더는 그 DB 폴더에 갇힌다", () => {
    expect(enclosingDatabaseFolder("Home/과제/기타", l)).toBe("Home/과제");
    expect(enclosingDatabaseFolder("Home/과제/기타/더 깊이", l)).toBe("Home/과제");
  });

  it("행의 폴더 안은 페이지 영역이다", () => {
    expect(enclosingDatabaseFolder("Home/과제/과제 A/하위", l)).toBeNull();
  });

  it("DB 와 무관한 폴더 · DB 폴더 자신은 아니다", () => {
    expect(enclosingDatabaseFolder("Home/새 폴더", l)).toBeNull();
    expect(enclosingDatabaseFolder("새 폴더/더 깊이", l)).toBeNull();
    expect(enclosingDatabaseFolder("Home/과제", l)).toBeNull();
  });
});
