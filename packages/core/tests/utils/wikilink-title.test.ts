import { describe, it, expect } from "vitest";
import { wikilinkTitleFromPath } from "../../src/utils/wikilink-title.js";

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
});
