/**
 * 오프라인 블록 택소노미 완전성 잠금 (I1·I2 push-side) — 단일 문서에 전 블록 타입을 한 번에
 * 통과시켜 **실 BlockConverter(martian + postProcessBlocks + normalize)** 가 어떤 타입도
 * 침묵 드롭하지 않고, 보존 마커가 리터럴로 새지 않으며, 중첩이 평탄화되지 않음을 단언한다.
 *
 * 배경(rank3/I1): 오프라인 라운드트립 하네스(roundtrip-fidelity.ts)는 pre/post-processor
 * 파이프라인만 왕복하고 BlockConverter 를 거치지 않아 "블록 무손실"을 증명하지 못한다(거짓
 * 안전망). block-converter.test.ts 의 **기능별** 유닛 + block-roundtrip.invariant(라이브)
 * 사이에, 한 문서가 전 기능을 동시에 통과할 때의 **교차 간섭**을 잡는 오프라인 결정론 잠금이
 * 비어 있었다. 본 테스트가 그 공백을 메운다.
 *
 * 부분문자열이 아니라 블록 타입 히스토그램 + 구조 단언으로 검증한다(거짓종료방지).
 */
import { describe, it, expect } from "vitest";
import { BlockConverter } from "../../src/converter/block-converter.js";
import { TOC_MARKER, BREADCRUMB_MARKER } from "../../src/constants/markers.js";

// Obsidian 콜아웃 문법(`> [!warning]`)·이모지→callout 변환은 파이프라인 CalloutTransformer
// 의 책임이라 BlockConverter 단독으로는 비결정적이다. 따라서 이 오프라인 문서는 BlockConverter
// 가 결정론적으로 책임지는 타입만 담는다(콜아웃은 block-roundtrip.invariant 가 라이브로 검증).
const TAXONOMY = `${BREADCRUMB_MARKER}

# 헤딩 1

${TOC_MARKER}

본문 **굵게** *기울임* \`인라인코드\` ~~취소선~~ 그리고 %%im-nobsidian:underline%%밑줄%%/underline%% %%im-nobsidian:color:red%%빨강%%/color%%.

## 헤딩 2

- 최상위
  - 2단계
    - 3단계
- 또 다른 최상위

1. 첫째
2. 둘째

- [ ] 할 일
- [x] 완료된 일

> 일반 인용문

### 헤딩 3

\`\`\`typescript
const x: number = 1;
\`\`\`

$$
E = mc^2
$$

| 이름 | 값 |
| --- | --- |
| A | 1 |

[링크](https://example.com)

---

마지막 문단.
`;

interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

describe("오프라인 블록 택소노미 완전성 (I1·I2 push-side)", () => {
  const converter = new BlockConverter();
  const blocks = converter.markdownToNotionBlocks(TAXONOMY) as NotionBlock[];

  const histogram = blocks.reduce<Record<string, number>>((acc, b) => {
    acc[b.type] = (acc[b.type] ?? 0) + 1;
    return acc;
  }, {});

  it("전 블록 타입이 생존한다(어떤 타입도 0 으로 드롭되지 않음)", () => {
    // 마커 전용 블록 — 보존 마커가 일반 문단으로 새지 않고 전용 블록으로 복원돼야 한다.
    expect(histogram["breadcrumb"], "breadcrumb 드롭").toBe(1);
    expect(histogram["table_of_contents"], "table_of_contents 드롭").toBe(1);
    // 헤딩 3종.
    expect(histogram["heading_1"], "heading_1 드롭").toBe(1);
    expect(histogram["heading_2"], "heading_2 드롭").toBe(1);
    expect(histogram["heading_3"], "heading_3 드롭").toBe(1);
    // 리스트(상위 항목 기준 — 중첩은 children 으로 들어감).
    expect(histogram["bulleted_list_item"] ?? 0, "불릿 리스트 드롭").toBeGreaterThanOrEqual(2);
    expect(histogram["numbered_list_item"] ?? 0, "번호 리스트 드롭").toBeGreaterThanOrEqual(2);
    // 작업목록 2개(체크/언체크).
    expect(histogram["to_do"] ?? 0, "to_do 드롭").toBe(2);
    // 인용·코드·수식·테이블·구분선.
    expect(histogram["quote"] ?? 0, "quote 드롭").toBeGreaterThanOrEqual(1);
    expect(histogram["code"] ?? 0, "code 드롭").toBe(1);
    expect(histogram["equation"] ?? 0, "equation(블록 수식) 드롭").toBe(1);
    expect(histogram["table"] ?? 0, "table 드롭").toBe(1);
    expect(histogram["divider"] ?? 0, "divider 드롭").toBe(1);
    // 인라인 서식·링크·문단.
    expect(histogram["paragraph"] ?? 0, "paragraph 드롭").toBeGreaterThanOrEqual(3);
  });

  it("code 블록은 언어를 보존한다", () => {
    const code = blocks.find((b) => b.type === "code");
    expect((code?.["code"] as { language?: string } | undefined)?.language).toBe("typescript");
  });

  it("to_do 는 체크/언체크 상태를 정확히 보존한다", () => {
    const todos = blocks.filter((b) => b.type === "to_do");
    const checked = todos.map((t) => (t["to_do"] as { checked: boolean }).checked).sort();
    expect(checked).toEqual([false, true]); // 정확히 하나는 false, 하나는 true
  });

  it("3단 중첩 리스트가 평탄화되지 않고 children 으로 보존된다", () => {
    const firstBullet = blocks.find((b) => b.type === "bulleted_list_item");
    const depth = (b: NotionBlock | undefined, d = 1): number => {
      const payload = b?.[b.type] as { children?: NotionBlock[] } | undefined;
      const kids = payload?.children;
      return Array.isArray(kids) && kids.length > 0 ? depth(kids[0], d + 1) : d;
    };
    expect(depth(firstBullet), "3단 중첩 평탄화됨").toBeGreaterThanOrEqual(3);
  });

  it("보존 마커·인라인 주석이 리터럴로 새지 않는다(누출 0)", () => {
    const json = JSON.stringify(blocks);
    // compact underline/color 마커는 블록 변환 시 평문으로 강등 — 리터럴 누출 0.
    expect(json).not.toContain("im-nobsidian:underline");
    expect(json).not.toContain("im-nobsidian:color");
    expect(json).not.toContain("%%/");
    // breadcrumb/toc 마커 텍스트는 전용 블록으로 변환되어 rich_text 에 리터럴로 남지 않는다.
    expect(json).not.toContain(BREADCRUMB_MARKER);
    expect(json).not.toContain(TOC_MARKER);
    // 강등돼도 내용(텍스트)은 보존된다.
    expect(json).toContain("밑줄");
    expect(json).toContain("빨강");
  });
});
