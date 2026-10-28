/**
 * 같은 이름의 두 겹 폴더 페이지 찾기(ADR-012 트레이드오프 · P2).
 *
 * v0.3.x · v0.4 개발 빌드는 폴더 페이지 아래 같은 제목의 폴더 노트를 만들었고, 폴더 레코드를 놓친 뒤 pull 이
 * 폴더 페이지를 `F/F (id).md` 로 받았다. 고치지 않고 찾아서 알리기만 한다.
 */
import { describe, it, expect } from "vitest";
import { findNestedFolderPages } from "../../src/audit/nested-folder-pages.js";
import type { NestedFolderRecord } from "../../src/audit/nested-folder-pages.js";

const OUTER = "11111111-1111-4111-8111-111111111111";
const INNER = "22222222-2222-4222-8222-222222222222";
const ROOT = "99999999-9999-4999-8999-999999999999";

const record = (
  obsidianPath: string,
  notionPageId: string | null,
  notionParentId: string | null,
  fileType = "file",
): NestedFolderRecord => ({ obsidianPath, notionPageId, notionParentId, fileType });

describe("findNestedFolderPages", () => {
  it("폴더 레코드 아래 같은 이름의 폴더 노트 — 폴더 레코드가 남은 두 겹", () => {
    const found = findNestedFolderPages([
      record("상위/프로젝트", OUTER, ROOT, "folder-only"),
      record("상위/프로젝트/프로젝트.md", INNER, OUTER, "folder-note"),
      record("상위/프로젝트/메모.md", "33333333-3333-4333-8333-333333333333", INNER),
    ]);
    expect(found).toEqual([
      {
        folder: "상위/프로젝트",
        outer: { path: "상위/프로젝트", notionPageId: OUTER },
        inner: { path: "상위/프로젝트/프로젝트.md", notionPageId: INNER },
      },
    ]);
  });

  it("폴더 레코드를 놓친 뒤 받은 `F/F (id).md` — id 꼬리를 떼고 본다", () => {
    const found = findNestedFolderPages([
      record("프로젝트/프로젝트 (11111111).md", OUTER, ROOT),
      record("프로젝트/프로젝트.md", INNER, OUTER.replace(/-/g, ""), "folder-note"),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      folder: "프로젝트",
      outer: { path: "프로젝트/프로젝트 (11111111).md" },
      inner: { path: "프로젝트/프로젝트.md" },
    });
  });

  it("정상 트리는 없다 — 폴더 노트의 부모가 상위 폴더 노트 · 이름이 다른 자식 · DB 행", () => {
    expect(
      findNestedFolderPages([
        record("상위/상위.md", OUTER, ROOT, "folder-note"),
        record("상위/하위/하위.md", INNER, OUTER, "folder-note"),
        record("상위/메모.md", "33333333-3333-4333-8333-333333333333", OUTER),
        record("상위/메모 (44444444).md", "44444444-4444-4444-8444-444444444444", OUTER),
        record("작업/작업.md", "55555555-5555-4555-8555-555555555555", OUTER, "db-row"),
        record("작업", "66666666-6666-4666-8666-666666666666", null, "folder-only"),
      ]),
    ).toEqual([]);
  });
});
