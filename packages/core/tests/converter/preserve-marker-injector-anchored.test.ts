import { describe, it, expect } from "vitest";
import { PreserveMarkerInjector } from "../../src/converter/post-processors/preserve-marker-injector.js";
import type { ProcessorInput, PreserveMarker } from "../../src/types/convert.js";

/**
 * F28/F29 재발 방지 — __anchor 를 가진 신규 마커의 재삽입 계약:
 * 프론트매터 침범 금지, 의미적 복원 감지, __raw 렌더, 빈 마커 폐기, 앵커 위치 삽입.
 * (레거시 무앵커 마커의 정확 오프셋 계약은 preserve-marker-injector.test.ts 가 보증)
 */
describe("PreserveMarkerInjector — anchored (신규 계약)", () => {
  const injector = new PreserveMarkerInjector();
  const pullContext = {
    direction: "pull" as const,
    path: "markdown-api" as const,
    filePath: "test.md",
  };

  function run(content: string, markers: PreserveMarker[]) {
    const input: ProcessorInput = {
      content,
      metadata: { preserveMarkers: markers },
      context: pullContext,
    };
    return injector.process(input).content;
  }

  it("F28: 앵커 마커는 프론트매터 앞에 절대 삽입되지 않음", () => {
    const content = "---\ntitle: 문서\n---\n\n본문 문단";
    const result = run(content, [
      { type: "wikilink", params: { text: "없는링크", __anchor: "" }, startIndex: 0 },
    ]);
    expect(result.startsWith("---\ntitle: 문서\n---")).toBe(true);
    const markerPos = result.indexOf("im-nobsidian:wikilink");
    const fmClose = result.indexOf("\n---", 3);
    expect(markerPos).toBeGreaterThan(fmClose);
  });

  it("F28: 이미 [[위키링크]] 로 복원된 마커는 재삽입하지 않음", () => {
    const content = "본문에 [[프로브 위키링크]] 가 있다";
    const result = run(content, [
      {
        type: "wikilink",
        params: { text: "프로브 위키링크", __anchor: "본문에" },
        startIndex: 5,
      },
    ]);
    expect(result).toBe(content);
  });

  it("별칭형 [[링크|표시]] 복원도 감지", () => {
    const content = "본문에 [[대상|표시명]] 이 있다";
    const result = run(content, [
      {
        type: "wikilink",
        params: { text: "대상", display: "표시명", __anchor: "" },
        startIndex: 0,
      },
    ]);
    expect(result).toBe(content);
  });

  it("F29: __raw 마커는 원문 페이로드로 렌더 (k=v 아님)", () => {
    const result = run("본문", [
      { type: "local-image", params: { __raw: "probe-image.png", __anchor: "" }, startIndex: 0 },
    ]);
    expect(result).toContain("%% im-nobsidian:local-image:probe-image.png %%");
  });

  it("F29: ![[임베드]] 로 복원된 local-image 마커는 재삽입하지 않음", () => {
    const content = "![[probe-image.png]]";
    const result = run(content, [
      { type: "local-image", params: { __raw: "probe-image.png", __anchor: "" }, startIndex: 0 },
    ]);
    expect(result).toBe(content);
  });

  it("F29: 빈 params 마커(레거시 껍데기)는 폐기 — 본문 무변경", () => {
    const content = "본문 그대로";
    const result = run(content, [{ type: "local-image", params: {}, startIndex: 3 }]);
    // 렌더 불가(null) → 삽입도 파손도 없음 (과거엔 단어 한가운데 껍데기 마커가 박혔다)
    expect(result).toBe(content);
  });

  it("comment 마커는 %%원문%% 으로, 앵커 줄 다음에 단독 줄 삽입", () => {
    const content = "---\ntitle: t\n---\n앞 문단입니다.\n뒤 문단입니다.";
    const result = run(content, [
      {
        type: "comment",
        params: { text: "사적 메모", __anchor: "앞 문단입니다." },
        startIndex: 999,
      },
    ]);
    const lines = result.split("\n");
    const anchorIdx = lines.indexOf("앞 문단입니다.");
    expect(lines[anchorIdx + 1]).toBe("%%사적 메모%%");
  });

  it("style=html comment 마커는 <!--원문--> 으로 복원 (F26 확장)", () => {
    const content = "---\ntitle: t\n---\n앞 문단입니다.\n뒤 문단입니다.";
    const result = run(content, [
      {
        type: "comment",
        params: { text: " 비밀 메모 ", style: "html", __anchor: "앞 문단입니다." },
        startIndex: 999,
      },
    ]);
    const lines = result.split("\n");
    const anchorIdx = lines.indexOf("앞 문단입니다.");
    expect(lines[anchorIdx + 1]).toBe("<!-- 비밀 메모 -->");
    expect(result).not.toContain("%%");
  });

  it("앵커를 못 찾으면 줄 경계로 삽입하되 단어를 자르지 않음", () => {
    const content = "첫 줄\n둘째 줄";
    const result = run(content, [
      { type: "comment", params: { text: "메모", __anchor: "존재하지 않는 앵커" }, startIndex: 2 },
    ]);
    expect(result).toContain("%%메모%%");
    // 단어 중간 삽입 금지 — 원본 줄들은 온전히 남는다
    expect(result).toContain("첫 줄");
    expect(result).toContain("둘째 줄");
  });

  it("table-align 마커는 전용 복원기 소관 — 재삽입하지 않음", () => {
    const content = "| a |\n| --- |";
    const result = run(content, [
      { type: "table-align", params: { align: "left", __anchor: "| a |" }, startIndex: 0 },
    ]);
    expect(result).toBe(content);
  });

  it("동일 마커가 본문에 이미 있으면 중복 삽입 안 함", () => {
    const content = "%% im-nobsidian:local-image:a.png %%";
    const result = run(content, [
      { type: "local-image", params: { __raw: "a.png", __anchor: "" }, startIndex: 0 },
    ]);
    expect(result).toBe(content);
  });
});
