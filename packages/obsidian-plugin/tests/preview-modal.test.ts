/**
 * Sync 미리 보기(P8) — CLI `sync --dry-run` 처럼 반영하지 않고 무엇을 할지 보인다.
 */
import { describe, it, expect } from "vitest";
import type { ProgressItem, SyncResult } from "@im-nobsidian/core";
import { LISTED_PATHS, previewSections } from "../src/preview-modal.js";

function result(
  overrides: { pull?: object; push?: object; conflicts?: unknown[] } = {},
): SyncResult {
  return {
    pull: { created: 0, updated: 0, deleted: 0, failed: [], ...overrides.pull },
    push: { created: 0, updated: 0, deleted: 0, moved: 0, failed: [], ...overrides.push },
    conflicts: overrides.conflicts ?? [],
    duration: 0,
  } as unknown as SyncResult;
}

function item(
  path: string,
  operation: ProgressItem["operation"],
  direction: "pull" | "push",
  unchanged = false,
) {
  return { path, operation, direction, ...(unchanged ? { unchanged } : {}) } as ProgressItem;
}

describe("previewSections", () => {
  it("할 일이 없으면 묶음도 없다", () => {
    expect(previewSections({ result: result(), items: [] })).toEqual([]);
  });

  it("받을 것과 올릴 것을 가르고, 받아 보기만 할 노트와 다시 온 같은 할 일은 빼다", () => {
    const sections = previewSections({
      result: result(),
      items: [
        item("새 페이지.md", "create", "pull"),
        item("그대로.md", "update", "pull", true),
        item("고친 노트.md", "update", "push"),
        item("고친 노트.md", "update", "push"),
        item("지운 노트.md", "delete", "push"),
      ],
    });
    expect(sections).toEqual([
      { heading: "Notion 에서 받을 것 1", lines: ["새로 — 새 페이지.md"], problem: false },
      {
        heading: "Notion 에 올릴 것 2",
        lines: ["고침 — 고친 노트.md", "지움 — 지운 노트.md"],
        problem: false,
      },
    ]);
  });

  it("충돌로 남을 것 · 처리하지 못할 것은 문제로 보인다", () => {
    const sections = previewSections({
      result: result({
        conflicts: [{ syncRecord: { obsidianPath: "둘 다.md" } }],
        push: {
          failed: [{ path: "큰.mp4", operation: "create", error: "첨부 업로드 실패 — 400" }],
        },
      }),
      items: [],
    });
    expect(sections.map(({ heading, problem }) => [heading, problem])).toEqual([
      ["충돌로 남을 것 1", true],
      ["처리하지 못할 것 1", true],
    ]);
    expect(sections[1]!.lines).toEqual(["큰.mp4: 첨부 업로드 실패 — 400"]);
  });

  it("DB 구조 · 삭제 보류 · 범위 밖은 「그 밖에」 로 보인다", () => {
    const [other] = previewSections({
      result: result({
        push: {
          createdDatabases: 1,
          schemaEdits: [{ path: "작업/작업.notion.json" }],
          renamedProperties: [{ from: "상태", to: "진행" }],
          unsentDeletions: ["옛.md"],
        },
        pull: { excluded: ["밖.md"] },
      }),
      items: [],
    });
    expect(other).toEqual({
      heading: "그 밖에",
      lines: [
        "Notion DB 1개를 만듭니다",
        "DB 속성을 고칩니다 — 작업/작업.notion.json",
        "Notion 열 이름을 바꿉니다 — 상태 → 진행",
        "볼트에서 지운 노트 1개는 Notion 에서 지우지 않습니다(삭제 동기화 꺼짐)",
        "동기화 범위 밖이라 받지 않는 Notion 페이지 1개",
      ],
      problem: false,
    });
  });

  it("많으면 줄이고 남은 수를 적는다", () => {
    const items = Array.from({ length: LISTED_PATHS + 2 }, (_, n) =>
      item(`n${n}.md`, "create", "push"),
    );
    const [pushed] = previewSections({ result: result(), items });
    expect(pushed!.heading).toBe(`Notion 에 올릴 것 ${LISTED_PATHS + 2}`);
    expect(pushed!.lines.at(-1)).toBe("외 2개");
    expect(pushed!.lines).toHaveLength(LISTED_PATHS + 1);
  });
});
