import { describe, it, expect } from "vitest";
import {
  BlockSpacer,
  respace,
  isCompactExport,
} from "../../src/converter/post-processors/block-spacer.js";
import type { ProcessorInput } from "../../src/types/convert.js";

describe("respace — Notion 압축형 export 블록 간격 복원 (D1/D4)", () => {
  it("인접 문단 사이에 빈 줄을 복원한다", () => {
    expect(respace("첫 문단\n둘째 문단\n")).toBe("첫 문단\n\n둘째 문단\n");
  });

  it("제목-문단 경계를 분리한다", () => {
    expect(respace("# H1\n본문\n## H2\n")).toBe("# H1\n\n본문\n\n## H2\n");
  });

  it("리스트 항목은 한 블록으로 붙인다", () => {
    expect(respace("- a\n- b\n- c\n다음 문단\n")).toBe("- a\n- b\n- c\n\n다음 문단\n");
  });

  it("탭 들여쓰기 중첩 리스트를 4-space 로 정규화한다", () => {
    expect(respace("- 부모\n\t- 자식\n\t\t- 손자\n")).toBe("- 부모\n    - 자식\n        - 손자\n");
  });

  it("연속 콜아웃을 별개 블록으로 분리한다 — 병합 방지", () => {
    const input = "> [!note] A\n> 본문A\n> [!warning] B\n> 본문B\n";
    expect(respace(input)).toBe("> [!note] A\n> 본문A\n\n> [!warning] B\n> 본문B\n");
  });

  it("일반 인용 연속은 한 블록으로 유지한다", () => {
    expect(respace("> 한 줄\n> 두 줄\n")).toBe("> 한 줄\n> 두 줄\n");
  });

  it("표 행을 한 블록으로 붙인다", () => {
    const input = "| a | b |\n| --- | --- |\n| 1 | 2 |\n끝\n";
    expect(respace(input)).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n끝\n");
  });

  it("각주 정의 연속을 한 블록으로 유지한다", () => {
    expect(respace("본문[^1]\n[^1]: 정의1\n[^2]: 정의2\n")).toBe(
      "본문[^1]\n\n[^1]: 정의1\n[^2]: 정의2\n",
    );
  });

  it("코드 펜스 내부(빈 줄·탭·리스트 문법 포함)는 건드리지 않는다", () => {
    const fence = "```js\nconst a = 1;\n\n\tif (a) {}\n- not a list\n```";
    expect(respace(`앞\n${fence}\n뒤\n`)).toBe(`앞\n\n${fence}\n\n뒤\n`);
  });

  it("수식 펜스($$) 내부는 건드리지 않는다", () => {
    const math = "$$\nE = mc^2\n$$";
    expect(respace(`앞\n${math}\n`)).toBe(`앞\n\n${math}\n`);
  });

  it("브랜드 보존 마커 줄은 직전 블록(앵커)에 붙인다", () => {
    const input = "앵커 문단\n%% im-nobsidian:wikilink:text=Note %%\n다음 문단\n";
    expect(respace(input)).toBe("앵커 문단\n%% im-nobsidian:wikilink:text=Note %%\n\n다음 문단\n");
  });

  it("quote+마커 쌍(로컬 첨부 표현)은 한 블록으로 유지한다", () => {
    const pair = "> 📎 f.png\n> %% im-nobsidian:local-image:f.png %%";
    expect(respace(`앞\n${pair}\n뒤\n`)).toBe(`앞\n\n${pair}\n\n뒤\n`);
  });

  it("선두 프론트매터는 원형 보존하고 본문과 빈 줄 하나로 잇는다", () => {
    const input = "---\ncreated: 2026-07-14\ntags:\n  - a\n---\n첫 문단\n둘째\n";
    expect(respace(input)).toBe("---\ncreated: 2026-07-14\ntags:\n  - a\n---\n\n첫 문단\n\n둘째\n");
  });

  it("이미 표준 간격인 문서는 그대로 통과한다(멱등)", () => {
    const wellFormed =
      "---\na: 1\n---\n\n# 제목\n\n문단 하나\n\n- l1\n- l2\n\n> [!note]\n> 콜아웃\n";
    expect(respace(wellFormed)).toBe(wellFormed);
    expect(respace(respace(wellFormed))).toBe(respace(wellFormed));
  });

  it("말미 개행 유무를 보존한다", () => {
    expect(respace("a\nb")).toBe("a\n\nb");
    expect(respace("a\nb\n")).toBe("a\n\nb\n");
  });
});

describe("respace — sourceCompact 플래그 (D1 f14 회귀)", () => {
  // f14 실측: <empty-block/>(명시적 빈 문단)이 enhanced 변환에서 빈 줄로 바뀌어
  // 압축 문서에 빈 줄이 섞인다. 휴리스틱은 이를 저작형으로 오판해 스킵했다.
  const emptyBlockDerived = "문단 하나\n문단 둘\n\n---\n\n> *인용*\n문단 셋\n";

  it("true: 빈 줄이 섞여 있어도(<empty-block/> 유래) 재간격한다", () => {
    expect(respace(emptyBlockDerived, true)).toBe(
      "문단 하나\n\n문단 둘\n\n---\n\n> *인용*\n\n문단 셋\n",
    );
  });

  it("true: 빈 줄로 분리된 같은 종류 블록(리스트·인용)을 재병합하지 않는다", () => {
    expect(respace("- a\n- b\n\n- c\n", true)).toBe("- a\n- b\n\n- c\n");
    expect(respace("> A\n\n> B\n", true)).toBe("> A\n\n> B\n");
    expect(respace("| a |\n| - |\n\n| b |\n| - |\n", true)).toBe("| a |\n| - |\n\n| b |\n| - |\n");
  });

  it("false: 압축형이라도 무동작(blocks-API 폴백 산출물 보호)", () => {
    expect(respace("a\nb\n", false)).toBe("a\nb\n");
  });

  it("미지정: 기존 휴리스틱 폴백 — 빈 줄 있으면 무동작", () => {
    expect(respace("a\n\nb\nc\n")).toBe("a\n\nb\nc\n");
  });
});

describe("isCompactExport — 원시 export 압축형 판정 (D1)", () => {
  it("<empty-block/> 토큰만 있는 원시 export 는 압축형이다", () => {
    expect(isCompactExport("문단\n<empty-block/>\n다음\n")).toBe(true);
  });

  it("코드 펜스 내부 빈 줄은 계수하지 않는다", () => {
    expect(isCompactExport("앞\n```js\na\n\nb\n```\n뒤\n")).toBe(true);
  });

  it("펜스 밖 빈 줄이 있으면 압축형이 아니다", () => {
    expect(isCompactExport("앞\n\n뒤\n")).toBe(false);
  });

  it("말미 빈 줄은 계수하지 않는다", () => {
    expect(isCompactExport("한 줄뿐\n\n")).toBe(true);
  });
});

describe("BlockSpacer 프로세서", () => {
  it("push 방향에서는 무동작", () => {
    const input: ProcessorInput = {
      content: "a\nb",
      metadata: {},
      context: { direction: "push", path: "markdown-api", filePath: "t.md" },
    };
    expect(new BlockSpacer().process(input).content).toBe("a\nb");
  });

  it("pull 방향에서 간격을 복원한다", () => {
    const input: ProcessorInput = {
      content: "a\nb",
      metadata: {},
      context: { direction: "pull", path: "markdown-api", filePath: "t.md" },
    };
    expect(new BlockSpacer().process(input).content).toBe("a\n\nb");
  });

  it("metadata.notionExportCompact=true 를 respace 에 전달한다 (f14 회귀)", () => {
    const input: ProcessorInput = {
      content: "a\nb\n\nc\nd",
      metadata: { notionExportCompact: true },
      context: { direction: "pull", path: "markdown-api", filePath: "t.md" },
    };
    expect(new BlockSpacer().process(input).content).toBe("a\n\nb\n\nc\n\nd");
  });

  it("metadata.notionExportCompact=false 면 압축형이라도 무동작한다", () => {
    const input: ProcessorInput = {
      content: "a\nb",
      metadata: { notionExportCompact: false },
      context: { direction: "pull", path: "markdown-api", filePath: "t.md" },
    };
    expect(new BlockSpacer().process(input).content).toBe("a\nb");
  });
});
