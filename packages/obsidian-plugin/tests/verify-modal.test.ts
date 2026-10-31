/**
 * 빠짐없이 받았는지(P8) — CLI `verify` 의 결과를 플러그인에서 본다. 「읽지 못했다」 를 「없다」 로 접지 않는다.
 */
import { describe, it, expect } from "vitest";
import type { VaultCompletenessReport } from "@im-nobsidian/core";
import { LISTED_IDS, verifySections } from "../src/verify-modal.js";

const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
const URL = (n: number) =>
  `https://www.notion.so/${String(n).padStart(8, "0")}000000000000000000000000`;

function report(overrides: Partial<VaultCompletenessReport> = {}): VaultCompletenessReport {
  return {
    databases: { databases: [], failures: [], remoteTotal: 0, localTotal: 0, complete: true },
    pages: { remotePages: 3, vaultPages: 3, missingIds: [], localOnlyIds: [], complete: true },
    nestedFolderPages: [],
    complete: true,
    ...overrides,
  };
}

const noPath = () => null;

describe("verifySections", () => {
  it("다 받았으면 문제 묶음이 없다", () => {
    expect(verifySections({ label: "볼트", report: report(), pathOf: noPath })).toEqual([
      { heading: "Notion 페이지", lines: ["Notion 페이지 3 · 볼트 페이지 3"], problem: false },
    ]);
  });

  it("볼트에 없는 행은 Notion 주소로, Notion 에 없는 행은 볼트 경로로, 읽지 못한 DB 는 따로 문제로", () => {
    const [db] = verifySections({
      label: "볼트",
      pathOf: (id) => (id === ID(3) ? "작업/남은 행.md" : null),
      report: report({
        databases: {
          databases: [
            {
              databaseId: ID(1),
              remoteRows: 2,
              localRows: 2,
              missingIds: [ID(2)],
              extraIds: [ID(3)],
            },
          ],
          failures: [{ databaseId: ID(9), error: "Notion 404" }],
          remoteTotal: 2,
          localTotal: 2,
          complete: false,
        },
        complete: false,
      }),
    });
    expect(db).toEqual({
      heading: "Notion DB 행",
      lines: [
        "DB 1개 · Notion 행 2 · 볼트 행 2",
        `볼트에 없는 행 1개 — DB ${URL(1)}`,
        `  ${URL(2)}`,
        "Notion 에 없는 행 1개 — Notion 에서 지웠거나 다른 곳으로 옮긴 행이 볼트에 남았습니다",
        "  작업/남은 행.md",
        `읽지 못한 DB — ${URL(9)}: Notion 404`,
      ],
      problem: true,
    });
  });

  it("DB 모드면 페이지를 견주지 않았다고 말하고, 페이지 목록을 읽지 못했으면 문제로", () => {
    expect(
      verifySections({ label: "볼트", report: report({ pages: null }), pathOf: noPath }),
    ).toEqual([
      { heading: "Notion 페이지", lines: ["DB 모드라 페이지는 견주지 않습니다."], problem: false },
    ]);
    const [pages] = verifySections({
      label: "볼트",
      pathOf: noPath,
      report: report({
        pages: {
          remotePages: 0,
          vaultPages: 2,
          missingIds: [],
          localOnlyIds: [],
          error: "Notion 500",
          complete: false,
        },
        complete: false,
      }),
    });
    expect(pages).toEqual({
      heading: "Notion 페이지",
      lines: ["Notion 페이지 목록을 읽지 못했습니다 — Notion 500"],
      problem: true,
    });
  });

  it("볼트에만 있는 페이지 · 두 겹 폴더는 알리기만 하고, 많으면 줄인다", () => {
    const localOnly = Array.from({ length: LISTED_IDS + 1 }, (_, n) => ID(n));
    const sections = verifySections({
      label: "볼트",
      pathOf: noPath,
      report: report({
        pages: {
          remotePages: 1,
          vaultPages: 12,
          missingIds: [ID(50)],
          localOnlyIds: localOnly,
          complete: false,
        },
        nestedFolderPages: [
          {
            folder: "프로젝트",
            outer: { path: "프로젝트", notionPageId: ID(60) },
            inner: { path: "프로젝트/프로젝트", notionPageId: ID(61) },
          },
        ],
        complete: false,
      }),
    });
    expect(sections.map(({ heading, problem }) => [heading, problem])).toEqual([
      ["Notion 페이지", true],
      [`볼트에만 있는 페이지 ${LISTED_IDS + 1}개`, false],
      ["같은 이름으로 두 겹인 폴더 페이지 1개", false],
    ]);
    expect(sections[0]!.lines).toEqual([
      "Notion 페이지 1 · 볼트 페이지 12",
      "볼트에 없는 페이지 1개",
      `  ${URL(50)}`,
    ]);
    expect(sections[1]!.lines.at(-1)).toBe("외 1개");
    expect(sections[2]!.lines.at(-1)).toBe("  프로젝트 — 바깥 프로젝트 · 안쪽 프로젝트/프로젝트");
  });
});
