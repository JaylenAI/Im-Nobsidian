import { describe, it, expect } from "vitest";
import { wikilinkTitleFromPath, formatWikilink } from "../../src/utils/wikilink-title.js";
import { sanitizeFileName } from "../../src/utils/sanitize.js";

describe("wikilinkTitleFromPath (M4 SSOT)", () => {
  it("`.md` 확장자를 제거한다", () => {
    expect(wikilinkTitleFromPath("Notes/Hello.md")).toBe("Hello");
  });

  it("대소문자 무관하게 확장자를 제거한다", () => {
    expect(wikilinkTitleFromPath("Notes/Hello.MD")).toBe("Hello");
  });

  it("폴더 경로를 벗기고 basename 만 남긴다", () => {
    expect(wikilinkTitleFromPath("a/b/c/My Page.md")).toBe("My Page");
  });

  it("확장자 없는 경로도 basename 을 돌려준다", () => {
    expect(wikilinkTitleFromPath("databases/tasks/Task One")).toBe("Task One");
  });

  it("최상위(폴더 없는) 경로를 그대로 다룬다", () => {
    expect(wikilinkTitleFromPath("Root.md")).toBe("Root");
  });

  it("빈 문자열은 빈 문자열로", () => {
    expect(wikilinkTitleFromPath("")).toBe("");
  });

  it("핵심 불변식: 위키링크 텍스트는 파일명 금지문자를 포함하지 않는 sanitize 된 basename 이다", () => {
    // 단일 변환 패스(resolvePageId)와 후처리 패스(resolveNotionLinks)가 모두 이 함수를
    // 거치므로, 원시 제목에 슬래시·콜론이 있어도 두 경로가 만드는 `[[..]]` 텍스트는
    // 동일한 basename 으로 수렴한다. 경로의 basename 에는 디렉터리 구분자가 없다.
    const out = wikilinkTitleFromPath("Projects/2026 Q2/Report: Final.md");
    expect(out).toBe("Report: Final");
    expect(out).not.toContain("/");
  });

  it("불변식: 대괄호 제목도 조기 종료 없는 위키링크 본문으로 수렴한다 (M5)", () => {
    // 파일명은 sanitizeFileName 으로 만들어지고 위키링크 텍스트는 그 basename 에서
    // 파생되므로(M4 SSOT), 원시 제목에 대괄호가 있어도 `[[..]]` 본문에는 `[`/`]` 가
    // 남지 않는다. 즉 본문에 조기 종료를 일으키는 `]]` 가 생기지 않아 링크가 안전하다.
    const raw = "Attention [2017]";
    const path = `Papers/${sanitizeFileName(raw)}.md`;
    const text = wikilinkTitleFromPath(path);
    expect(text).not.toMatch(/[[\]]/);
    const wikilink = `[[${text}]]`;
    // 닫는 `]]` 단 하나만 존재해야 한다(본문 안에 `]]` 없음).
    expect(wikilink.indexOf("]]")).toBe(wikilink.length - 2);
  });
});

describe("formatWikilink (R10-C SSOT)", () => {
  it("라벨이 없으면 `[[대상]]`", () => {
    expect(formatWikilink("Home")).toBe("[[Home]]");
  });

  it("라벨이 대상과 다르면 `[[대상|라벨]]`", () => {
    expect(formatWikilink("AI Engineer (1)", "Home")).toBe("[[AI Engineer (1)|Home]]");
  });

  it("라벨이 대상과 같으면 접는다 — `[[X|X]]` 를 만들지 않는다", () => {
    // 실볼트 45건/12파일이 이 한 줄로 정리된다(breadcrumb 콜아웃의 자기별칭).
    expect(formatWikilink("ETC", "ETC")).toBe("[[ETC]]");
  });

  it("빈 라벨은 별칭으로 살린다 — 라벨 없음(undefined)과 다르다", () => {
    // `[](/p/<id>)` 같은 빈 라벨 링크를 `[[대상]]` 으로 바꾸면 원문에 없던 텍스트가
    // 생겨 왕복이 안 닫힌다. 빈 문자열은 `=== target` 도 `=== undefined` 도 아니다.
    expect(formatWikilink("Home", "")).toBe("[[Home|]]");
  });

  it("불변식: 출력에 자기별칭 형태가 존재하지 않는다", () => {
    for (const [target, label] of [
      ["Home", "Home"],
      ["긴 제목 (1)", "긴 제목 (1)"],
      ["a|b", "a|b"],
      ["", ""],
    ] as const) {
      expect(formatWikilink(target, label)).toBe(`[[${target}]]`);
    }
  });

  it("불변식: 멱등 — 접힌 결과의 대상으로 다시 불러도 같다", () => {
    const once = formatWikilink("ETC", "ETC");
    expect(formatWikilink("ETC")).toBe(once);
  });
});
