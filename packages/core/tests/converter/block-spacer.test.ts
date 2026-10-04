import { describe, it, expect } from "vitest";
import {
  BlockSpacer,
  respace,
  isCompactExport,
} from "../../src/converter/post-processors/block-spacer.js";
import { obsidianToNotionEnhanced } from "../../src/converter/enhanced-md-converter.js";
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

  // S-25 — 닫는 줄은 Obsidian 이 읽는 대로 가린다. 코드 속 ```bash · 짧은 펜스 줄에서 닫으면
  // 그 뒤 코드를 문단으로 보고 빈 줄을 끼워 코드가 바뀐다.
  describe("코드 속 펜스 모양 줄은 블록을 닫지 않는다(S-25)", () => {
    it("여는 것보다 짧은 펜스 · 정보 문자열이 붙은 펜스", () => {
      const fence = "````markdown\n예시:\n```bash\necho hi\n```\n끝\n````";
      expect(respace(`문단\n${fence}\n다음 문단`, true)).toBe(`문단\n\n${fence}\n\n다음 문단`);
    });

    it("같은 길이라도 정보 문자열이 붙은 줄", () => {
      const fence = "```js\n```python\nx\n```";
      expect(respace(`앞\n${fence}\n뒤`, true)).toBe(`앞\n\n${fence}\n\n뒤`);
    });

    it("여는 쪽보다 3칸 넘게 들여쓴 펜스", () => {
      const fence = "```\n    ```\n안\n```";
      expect(respace(`앞\n${fence}\n뒤`, true)).toBe(`앞\n\n${fence}\n\n뒤`);
    });

    it("물결 펜스는 백틱 줄로 닫히지 않는다", () => {
      const fence = "~~~\n```\n안\n~~~";
      expect(respace(`앞\n${fence}\n뒤`, true)).toBe(`앞\n\n${fence}\n\n뒤`);
    });

    it("정보 문자열에 백틱이 있는 줄은 펜스가 아니다 — 인라인 코드", () => {
      expect(respace("```js``` 는 인라인\n다음", true)).toBe("```js``` 는 인라인\n\n다음");
    });

    it("압축형 판정도 같은 기준으로 코드 속 빈 줄을 세지 않는다", () => {
      expect(isCompactExport("앞\n````md\n```\n\n안\n````\n뒤\n")).toBe(true);
    });
  });

  it("수식 펜스($$) 내부는 건드리지 않는다", () => {
    const math = "$$\nE = mc^2\n$$";
    expect(respace(`앞\n${math}\n`)).toBe(`앞\n\n${math}\n`);
  });

  // S-21 — Notion 은 목록 자식 수식을 $$ · 식 줄 모두 탭으로 내보낸다(실측). 떼어 내면 앞에 빈 줄이
  // 들어가 목록이 느슨한 목록이 되고 탭이 남았다. 자식 코드블록(S-24)과 같게 항목에 붙이고 편다.
  describe("목록 자식 수식은 항목에 붙고 구조 탭만 편다", () => {
    it("Notion 이 내보낸 모양 — 4칸으로 펴 항목에 붙인다", () => {
      expect(respace("- 항목\n\t$$\n\ty^2\n\t$$\n- 다음", true)).toBe(
        "- 항목\n    $$\n    y^2\n    $$\n- 다음",
      );
    });

    it("두 단계 중첩 — 부모 항목의 깊이만큼", () => {
      expect(respace("- a\n\t- b\n\t\t$$\n\t\tx\n\t\t$$", true)).toBe(
        "- a\n    - b\n        $$\n        x\n        $$",
      );
    });

    it("식 속 탭은 식이다 — 구조 탭 한 겹만 편다", () => {
      expect(respace("- 항목\n\t$$\n\t\t\\alpha\n\t$$", true)).toBe(
        "- 항목\n    $$\n    \t\\alpha\n    $$",
      );
    });

    it("식 줄이 구조 탭을 입지 않았으면 펴지 않는다", () => {
      const md = "- 항목\n\t$$\nx\n\t$$";
      expect(respace(md, true)).toBe(md);
    });

    it("들여쓰지 않은 수식은 목록 뒤 새 블록이다", () => {
      expect(respace("- 항목\n$$\nx\n$$", true)).toBe("- 항목\n\n$$\nx\n$$");
    });
  });

  // 4칸으로 펴면 빈 줄 뒤라 들여쓴 코드블록이 된다. Notion 은 빈 줄 뒤 2칸 들여쓴 줄을 앞 블록의
  // 자식으로 읽는다(2026-10-04 실측).
  describe("문단 · 인용의 자식은 2칸 들여써 앞 블록과 띄운다", () => {
    const T = "\t";
    const lines = (...l: string[]) => l.join("\n");

    it("인용의 자식 목록 · 문단 — 자식끼리도 블록마다 띄운다", () => {
      const raw = lines("> 인용", `${T}- 자식 항목`, `${T}자식 문단`, "다음 문단");
      expect(respace(raw, true)).toBe(
        lines("> 인용", "", "  - 자식 항목", "", "  자식 문단", "", "다음 문단"),
      );
    });

    it("문단의 자식 — 손자 목록은 목록 들여쓰기(4칸)를 2칸 위에 쌓는다", () => {
      const raw = lines("문단", `${T}- 자식`, `${T}${T}- 손자`, `${T}자식 문단`);
      expect(respace(raw, true)).toBe(
        lines("문단", "", "  - 자식", "      - 손자", "", "  자식 문단"),
      );
    });

    it("이어지는 인용은 자식 묶음 밖이다", () => {
      const raw = lines("> 앞 인용", `${T}자식`, "> 다음 인용");
      expect(respace(raw, true)).toBe(lines("> 앞 인용", "", "  자식", "", "> 다음 인용"));
    });

    it("자식 코드블록 — 코드 줄도 펜스와 같은 2칸이고, 코드 속 빈 줄 · 줄머리 탭은 코드다", () => {
      // Notion 은 펜스만 탭으로 들여쓰고 코드 줄은 열 0 에 둔다. 코드 줄을 열 0 에 두면 Obsidian 이
      // 코드 줄머리 공백을 2칸까지 떼어 보인다.
      const raw = lines(
        "> 인용",
        `${T}\`\`\`py`,
        "def f():",
        "    return 1",
        "",
        `${T}x`,
        `${T}\`\`\``,
        "뒤",
      );
      expect(respace(raw, true)).toBe(
        lines(
          "> 인용",
          "",
          "  ```py",
          "  def f():",
          "      return 1",
          "",
          `  ${T}x`,
          "  ```",
          "",
          "뒤",
        ),
      );
    });

    it("목록 자식 코드는 변환기가 맞춘 구조 탭만 펴서 2칸 위에 쌓는다", () => {
      // alignNestedCodeBodies 가 코드 줄을 펜스 깊이(탭 둘)로 맞춰 둔 모양
      const raw = lines("문단", `${T}- 항목`, `${T}${T}\`\`\`js`, `${T}${T}x()`, `${T}${T}\`\`\``);
      expect(respace(raw, true)).toBe(
        lines("문단", "", "  - 항목", "      ```js", "      x()", "      ```"),
      );
    });

    it("2칸으로 눌러 둔 콜아웃 자식도 같은 묶음이다", () => {
      const raw = lines("문단", "  > [!tip] 팁", "  > 본문", `${T}자식 문단`);
      expect(respace(raw, true)).toBe(
        lines("문단", "", "  > [!tip] 팁", "  > 본문", "", "  자식 문단"),
      );
    });

    it("자식 묶음 안 빈 줄(변환기가 끼운 경계)은 두 목록을 가른다", () => {
      const raw = lines("> 인용", `${T}- 하나`, "", `${T}- 둘`);
      expect(respace(raw, true)).toBe(lines("> 인용", "", "  - 하나", "", "  - 둘"));
    });

    it("자식의 --- 는 프론트매터가 아니라 구분선이다", () => {
      const raw = lines("문단", `${T}---`, `${T}자식`, `${T}---`);
      expect(respace(raw, true)).toBe(lines("문단", "", "  ---", "", "  자식", "", "  ---"));
    });

    it("목록 항목 · 각주 정의의 자식은 지금처럼 4칸이다 — 들여쓸 자리가 따로 있다", () => {
      expect(respace(lines("- 항목", `${T}자식 문단`, "뒤"), true)).toBe(
        lines("- 항목", "    자식 문단", "", "뒤"),
      );
      expect(respace(lines("[^1]: 정의", `${T}이어지는 문단`), true)).toBe(
        lines("[^1]: 정의", "", "    이어지는 문단"),
      );
    });

    it("push 는 2칸 자식을 그대로 보낸다 — Notion 이 빈 줄 뒤 2칸 줄을 앞 블록의 자식으로 읽는다", () => {
      const pulled = respace(
        lines(
          "> 인용",
          `${T}- 자식 항목`,
          `${T}${T}- 손자`,
          `${T}자식 문단`,
          `${T}\`\`\`py`,
          "def f():",
          "    return 1",
          `${T}\`\`\``,
          "> 다음 인용",
        ),
        true,
      );
      expect(obsidianToNotionEnhanced(pulled)).toBe(pulled);
    });
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
