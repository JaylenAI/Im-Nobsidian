import { describe, it, expect } from "vitest";
import { EmbedResolver } from "../../src/converter/pre-processors/embed.js";
import { LocalImageRestorer } from "../../src/converter/post-processors/local-image-restorer.js";
import { PreserveMarkerInjector } from "../../src/converter/post-processors/preserve-marker-injector.js";
import type { ProcessorInput } from "../../src/types/convert.js";

const pushContext = {
  direction: "push" as const,
  path: "markdown-api" as const,
  filePath: "test.md",
};
const pullContext = { ...pushContext, direction: "pull" as const };

function push(content: string) {
  const input: ProcessorInput = { content, metadata: {}, context: pushContext };
  return new EmbedResolver().process(input).content;
}

function pull(content: string) {
  const input: ProcessorInput = { content, metadata: {}, context: pullContext };
  return new LocalImageRestorer().process(input).content;
}

// R1: 자리표시자는 **한 줄**이어야 한다. 두 줄로 쓰면 Notion Markdown API 가 quote 를
// 두 블록으로 쪼개, 업로드 후 마커 줄만 지워지고 `📎 파일명` 줄이 미디어 옆에 유령으로
// 남는다(실측). 예전 두 줄 형태로 이미 올라간 문서를 위해 pull 복원은 양쪽을 다 받는다.
describe("비이미지 로컬 임베드 push (D5)", () => {
  it("![[*.pdf]] 를 quote+local-file 마커 쌍으로 변환한다", () => {
    expect(push("![[report.pdf]]")).toBe(
      "> 📎 report.pdf %% im-nobsidian:local-file:report.pdf %%",
    );
  });

  it("폴더 경로 임베드는 파일명만 표시하고 마커에 전체 경로를 보존한다", () => {
    expect(push("![[docs/spec.pdf]]")).toBe(
      "> 📎 spec.pdf %% im-nobsidian:local-file:docs/spec.pdf %%",
    );
  });

  it("이미지 임베드는 기존 local-image 마커 경로를 유지한다(회귀 가드)", () => {
    expect(push("![[img.png]]")).toBe("> 📎 img.png %% im-nobsidian:local-image:img.png %%");
  });

  it("노트 임베드(확장자 없음/.md)는 기존 보존 링크 경로를 유지한다", () => {
    expect(push("![[다른노트]]")).toContain("im-nobsidian://embed/");
    expect(push("![[other.md]]")).toContain("im-nobsidian://embed/other.md");
    expect(push("![[board.canvas]]")).toContain("im-nobsidian://embed/board.canvas");
  });
});

describe("비이미지 로컬 임베드 pull 복원 (D5)", () => {
  it("local-file 마커 쌍을 ![[경로]] 로 복원한다", () => {
    expect(pull("> 📎 spec.pdf\n> %% im-nobsidian:local-file:docs/spec.pdf %%")).toBe(
      "![[docs/spec.pdf]]",
    );
  });

  it("예전 두 줄 자리표시자도 계속 복원한다(하위호환)", () => {
    expect(pull("> 📎 spec.pdf\n> %% im-nobsidian:local-file:docs/spec.pdf %%")).toBe(
      "![[docs/spec.pdf]]",
    );
  });

  it("공백 있는 경로도 통째로 복원한다", () => {
    const original = "![[내 사진 모음/여름 휴가.png]]";
    expect(pull(push(original))).toBe(original);
  });

  it("크기 별칭이 붙은 이미지도 왕복한다", () => {
    const original = "![[assets/photo.png|300]]";
    expect(pull(push(original))).toBe(original);
  });

  it("왕복: ![[x.pdf]] → 마커 쌍 → ![[x.pdf]]", () => {
    const original = "앞 문단\n\n![[archive/백서.pdf]]\n\n뒤 문단";
    expect(pull(push(original))).toBe(original);
  });
});

describe("PreserveMarkerInjector — local-file 의미 복원 판정 (D5)", () => {
  it("본문에 ![[대상]] 이 이미 있으면 local-file 마커를 재삽입하지 않는다", () => {
    const content = "본문\n![[docs/spec.pdf]]\n끝\n";
    const input: ProcessorInput = {
      content,
      metadata: {
        preserveMarkers: [
          {
            type: "local-file",
            params: { __raw: "docs/spec.pdf", __anchor: "본문" },
            startIndex: 3,
            endIndex: 3,
          },
        ],
      },
      context: pullContext,
    };
    expect(new PreserveMarkerInjector().process(input).content).toBe(content);
  });
});
