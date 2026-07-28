import { describe, it, expect } from "vitest";
import { CommentStripper } from "../../src/converter/pre-processors/comment-stripper.js";
import type { ProcessorInput } from "../../src/types/convert.js";

const pushContext = {
  direction: "push" as const,
  path: "markdown-api" as const,
  filePath: "test.md",
};
const pullContext = { ...pushContext, direction: "pull" as const };

function run(content: string, direction: "push" | "pull" = "push") {
  const stripper = new CommentStripper();
  const input: ProcessorInput = {
    content,
    metadata: {},
    context: direction === "push" ? pushContext : pullContext,
  };
  return stripper.process(input);
}

describe("CommentStripper (F26)", () => {
  it("order 11 — FrontmatterExtractor(10) 뒤", () => {
    expect(new CommentStripper().order).toBe(11);
  });

  it("일반 %%주석%% 을 본문에서 제거하고 comment 마커로 보존", () => {
    const result = run("앞 문단.\n\n%%사적 메모%%\n\n뒤 문단.");
    expect(result.content).not.toContain("사적 메모");
    const markers = result.metadata.preserveMarkers ?? [];
    expect(markers).toHaveLength(1);
    expect(markers[0]!.type).toBe("comment");
    expect(markers[0]!.params.text).toBe("사적 메모");
    expect(markers[0]!.params.__anchor).toBe("앞 문단.");
  });

  it("im-nobsidian 브랜드 마커는 보존 (compact·spaced 모두)", () => {
    const content =
      "%%im-nobsidian:color:yellow_bg%%하이라이트%%/color%%\n\n%% im-nobsidian:local-image:a.png %%";
    const result = run(content);
    expect(result.content).toBe(content);
    expect(result.metadata.preserveMarkers ?? []).toHaveLength(0);
  });

  it("코드 펜스 안의 %% 는 건드리지 않음", () => {
    const content = "```\n%%코드 속 주석%%\n```";
    const result = run(content);
    expect(result.content).toBe(content);
  });

  it("pull 방향에서는 무동작", () => {
    const content = "%%주석%%";
    const result = run(content, "pull");
    expect(result.content).toBe(content);
  });

  it("여러 주석을 각각 마커로 수집", () => {
    const result = run("A %%하나%% B\n\nC %%둘%% D");
    const markers = result.metadata.preserveMarkers ?? [];
    expect(markers.map((m) => m.params.text)).toEqual(["하나", "둘"]);
    expect(result.content).not.toContain("하나");
    expect(result.content).not.toContain("둘");
  });

  it("여러 줄 주석도 제거·보존", () => {
    const result = run("앞\n\n%%줄1\n줄2%%\n\n뒤");
    expect(result.content).not.toContain("줄1");
    expect((result.metadata.preserveMarkers ?? [])[0]!.params.text).toBe("줄1\n줄2");
  });

  it("HTML 주석(<!--...-->)도 제거하고 style=html 마커로 보존 (P5 실측 누수)", () => {
    const result = run("앞 문단.\n\n<!-- 비밀 메모 -->\n\n뒤 문단.");
    expect(result.content).not.toContain("비밀 메모");
    expect(result.content).toContain("앞 문단.");
    expect(result.content).toContain("뒤 문단.");
    const markers = result.metadata.preserveMarkers ?? [];
    expect(markers).toHaveLength(1);
    expect(markers[0]!.type).toBe("comment");
    expect(markers[0]!.params.style).toBe("html");
    expect(markers[0]!.params.text).toBe(" 비밀 메모 ");
    expect(markers[0]!.params.__anchor).toBe("앞 문단.");
  });

  it("Obsidian·HTML 주석 혼재 시 각각 자기 문법 마커로 수집", () => {
    const result = run("A %%하나%% B\n\n<!--둘-->\n\nC");
    const markers = result.metadata.preserveMarkers ?? [];
    expect(markers.map((m) => [m.params.text, m.params.style ?? "obsidian"])).toEqual([
      ["하나", "obsidian"],
      ["둘", "html"],
    ]);
  });

  it("코드 펜스 안의 HTML 주석은 건드리지 않음", () => {
    const content = "```html\n<!-- 코드 예시 주석 -->\n```";
    const result = run(content);
    expect(result.content).toBe(content);
    expect(result.metadata.preserveMarkers ?? []).toHaveLength(0);
  });

  it("여러 줄 HTML 주석도 제거·보존", () => {
    const result = run("앞\n\n<!--줄1\n줄2-->\n\n뒤");
    expect(result.content).not.toContain("줄1");
    expect((result.metadata.preserveMarkers ?? [])[0]!.params.text).toBe("줄1\n줄2");
  });
});

/*
 * D-COMMENT-PAIR — 본문의 홑 `%%` 가 마커 구분자와 짝지어져 문장을 삼키던 결함.
 *
 * `%%` 를 위치로만 짝짓던 예전 구현은 `압축률 100%%` 의 `%%` 를 여는 구분자로,
 * 바로 뒤 색상 마커의 여는 `%%` 를 닫는 구분자로 잡았다. 그 사이 문장이 통째로
 * 삭제되고 마커 원문 조각(`im-nobsidian:color:yellow_bg/color%%`)이 본문에 노출됐다.
 * 마커 토큰을 먼저 떼어 내는 방식으로 바꿔 구조적으로 불가능해졌다.
 */
describe("CommentStripper — 마커 구분자 오인 (D-COMMENT-PAIR)", () => {
  it("홑 %% 가 있는 문장과 색상 마커가 같이 있어도 아무것도 잃지 않는다", () => {
    const content =
      "겹퍼센트 100%% 도 마커가 아니다.\n\n%%im-nobsidian:color:yellow_bg%%형광펜 강조%%/color%% 도 왕복.";
    const result = run(content);
    expect(result.content).toBe(content);
    expect(result.metadata.preserveMarkers ?? []).toHaveLength(0);
  });

  it("한 줄 안에서 섞여도 마찬가지", () => {
    const content = "한 줄에 100%% 와 %%im-nobsidian:color:yellow_bg%%형광펜%%/color%% 같이.";
    expect(run(content).content).toBe(content);
  });

  it("짝 없는 홑 %% 하나만 있으면 주석이 아니다", () => {
    const content = "겹퍼센트 100%% 도 마커가 아니다.";
    expect(run(content).content).toBe(content);
  });

  it("마커 사이에 낀 진짜 주석은 여전히 제거한다", () => {
    const result = run("%%im-nobsidian:toggle:start%%\n\n앞 문단. %%사적 메모%% 뒤.");
    expect(result.content).toContain("%%im-nobsidian:toggle:start%%");
    expect(result.content).not.toContain("사적 메모");
    expect((result.metadata.preserveMarkers ?? [])[0]!.params.text).toBe("사적 메모");
  });

  it("마커 뒤 주석의 앵커·offset 이 원문 기준으로 남는다", () => {
    const content = "%%im-nobsidian:toggle:start%%\n\n앞 문단. %%사적 메모%% 뒤.";
    const marker = (run(content).metadata.preserveMarkers ?? [])[0]!;
    expect(marker.params.__anchor).toBe("앞 문단. ");
    expect(marker.startIndex).toBe(content.indexOf("%%사적 메모%%"));
  });
});
