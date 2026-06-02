/**
 * I2 — 블록 라운드트립 **오프라인 결정론** 잠금 (rank7).
 *
 * 기존 I2(block-roundtrip.invariant.test.ts)는 실 Notion 으로 push/sync 를 반복하는
 * 라이브 테스트라 NOTION_TOKEN 이 없으면 skipIf 로 통째 건너뛴다 — 즉 CI/오프라인에서는
 * 블록 라운드트립 안정성이 **전혀** 검증되지 않았다(이원 도달성의 오프라인 축 공백).
 *
 * 본 테스트는 고정된 Notion 블록 JSON 픽스처를 출발점으로:
 *   notion 블록 → (notionBlockArrayToMarkdown) → MD → (markdownToNotionBlocks) → notion 블록
 * 을 수행하고, 두 블록 배열을 **정규화 투영**(type + 평문 텍스트 + 핵심 속성)으로 deep-equal
 * (toEqual) 비교한다. 부분일치(.toContain)가 아니라 **순서·개수·내용이 모두 일치**해야 하므로
 * 진행성 손실(타입 드롭·텍스트 깎임·속성 유실)이 있으면 즉시 실패한다(거짓종료방지).
 *
 * 오프라인 보장: 픽스처는 전부 `has_children:false` 인 평면 블록이라 notion-to-md 가
 * 자식 fetch 를 하지 않는다. 클라이언트는 호출 시 throw 하는 스텁을 주입해 **어떤 네트워크
 * 호출도 발생하지 않음**을 강제로 증명한다(호출되면 테스트가 터진다).
 */
import { describe, it, expect } from "vitest";
import type { Client } from "@notionhq/client";
import { BlockConverter } from "../../src/converter/block-converter.js";

/** 호출되면 즉시 실패하는 스텁 — 평면 블록 변환이 네트워크를 건드리지 않음을 강제 증명. */
const THROWING_CLIENT = new Proxy(
  {},
  {
    get() {
      throw new Error("오프라인 위반: Notion 클라이언트가 호출됨 (평면 블록은 fetch 금지)");
    },
  },
) as unknown as Client;

const DEFAULT_ANNOTATIONS = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
} as const;

/** 단일 text rich_text 항목 — notion-to-md 는 plain_text + annotations 를 읽는다. */
function rt(content: string): Record<string, unknown> {
  return {
    type: "text",
    text: { content, link: null },
    plain_text: content,
    href: null,
    annotations: { ...DEFAULT_ANNOTATIONS },
  };
}

/** 평면 블록 한 개를 만든다(has_children:false 강제 → 오프라인). */
function block(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { object: "block", id: `blk-${type}`, type, has_children: false, [type]: payload };
}

/**
 * 라운드트립 비교용 정규화 투영. 블록을 {type, text, ...핵심속성} 으로 축약해
 * id·created_time·annotations 기본값 등 라운드트립이 보존할 의무가 없는 잡음을 제거하고,
 * **타입·평문·핵심 속성**만 비교 대상으로 남긴다(I2 진행성 손실 탐지의 올바른 granularity).
 */
interface Projection {
  type: string;
  text: string;
  lang?: string;
  checked?: boolean;
}
function extractText(richText: unknown): string {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((it) => {
      const o = it as { text?: { content?: string }; plain_text?: string };
      return o.text?.content ?? o.plain_text ?? "";
    })
    .join("");
}
/**
 * martian 산출 블록은 `text.content` 만 있고 notion-to-md 가 읽는 `plain_text` 가 없다.
 * 두 번째 왕복(blocks→MD)을 돌리려면 rich_text 항목마다 plain_text 를 채워 넣어야 한다.
 */
function withPlainText(block: Record<string, unknown>): Record<string, unknown> {
  const type = block.type as string;
  const payload = block[type] as Record<string, unknown> | undefined;
  if (!payload) return block;
  const rt = payload.rich_text;
  if (Array.isArray(rt)) {
    const patched = rt.map((it) => {
      const o = it as { text?: { content?: string }; plain_text?: string };
      if (o.plain_text !== undefined) return it;
      return { ...o, plain_text: o.text?.content ?? "" };
    });
    return { ...block, [type]: { ...payload, rich_text: patched } };
  }
  return block;
}

function project(b: Record<string, unknown>): Projection {
  const type = b.type as string;
  const payload = (b[type] ?? {}) as Record<string, unknown>;
  if (type === "equation") {
    return { type, text: (payload.expression as string) ?? "" };
  }
  const out: Projection = { type, text: extractText(payload.rich_text) };
  if (type === "code") out.lang = payload.language as string;
  if (type === "to_do") out.checked = payload.checked as boolean;
  return out;
}

// 고정 픽스처 — 평면 블록만(table/callout 은 자식 fetch 가 필요하므로 제외).
const FIXTURE_BLOCKS: Array<Record<string, unknown>> = [
  block("heading_1", { rich_text: [rt("헤딩 1")], is_toggleable: false, color: "default" }),
  block("heading_2", { rich_text: [rt("헤딩 2")], is_toggleable: false, color: "default" }),
  block("heading_3", { rich_text: [rt("헤딩 3")], is_toggleable: false, color: "default" }),
  block("paragraph", { rich_text: [rt("본문 문단 텍스트")], color: "default" }),
  block("bulleted_list_item", { rich_text: [rt("불릿 항목")], color: "default" }),
  block("numbered_list_item", { rich_text: [rt("번호 항목")], color: "default" }),
  block("to_do", { rich_text: [rt("완료된 일")], checked: true, color: "default" }),
  block("to_do", { rich_text: [rt("할 일")], checked: false, color: "default" }),
  block("quote", { rich_text: [rt("인용문 본문")], color: "default" }),
  block("code", { rich_text: [rt("const x: number = 1;")], language: "typescript", caption: [] }),
  block("equation", { expression: "E = mc^2" }),
  block("divider", {}),
];

describe("I2 블록 라운드트립 오프라인 결정론 (rank7)", () => {
  const converter = new BlockConverter();
  converter.initNotionToMd(THROWING_CLIENT);

  it("고정 Notion 블록 → MD → 블록 재구성이 정규화 투영으로 정확히 일치(toEqual, 순서·개수·내용)", async () => {
    const md = await converter.notionBlockArrayToMarkdown(FIXTURE_BLOCKS);
    const reconstructed = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;

    const before = FIXTURE_BLOCKS.map(project);
    const after = reconstructed.map(project);

    // 전체 배열 deep-equal — 타입 드롭/텍스트 손실/속성 유실/순서 변동이 있으면 실패.
    expect(after).toEqual(before);
    // 개수 delta = 0 (toEqual 이 이미 강제하지만 명시적으로 한 번 더 잠근다).
    expect(after).toHaveLength(before.length);
  });

  it("두 번째 왕복도 fixpoint — MD→블록→MD→블록 이 1회차와 동일(진행성 손실 0)", async () => {
    const md1 = await converter.notionBlockArrayToMarkdown(FIXTURE_BLOCKS);
    const blocks1 = converter.markdownToNotionBlocks(md1) as Array<Record<string, unknown>>;
    // martian 산출 블록은 notion-to-md 입력에 필요한 plain_text 가 없으므로 주입한 뒤(평면 강제)
    // 두 번째 왕복을 돌린다.
    const md2 = await converter.notionBlockArrayToMarkdown(
      blocks1.map((b) => withPlainText({ ...b, has_children: false })),
    );
    const blocks2 = converter.markdownToNotionBlocks(md2) as Array<Record<string, unknown>>;

    // 마크다운 fixpoint(md2===md1) + 블록 투영 fixpoint 둘 다 잠근다.
    expect(md2).toBe(md1);
    expect(blocks2.map(project)).toEqual(blocks1.map(project));
  });
});

// ── 중첩 번호목록 회귀 잠금: numbered_list_item 커스텀 트랜스포머가 자식을 직접 fetch·들여쓰기
// 하므로(notion-to-md 기본 자식 처리가 꺼짐), 깊이 1 중첩이 타입·텍스트·구조 그대로 왕복하는지
// 확정 잠근다. 자식 fetch 만 흉내내는 목 클라이언트를 쓰되 그 외 네트워크는 일어나지 않는다.
describe("I2 중첩 번호목록 오프라인 라운드트립 (rank7)", () => {
  function num(id: string, text: string, hasChildren = false): Record<string, unknown> {
    return {
      object: "block",
      id,
      type: "numbered_list_item",
      has_children: hasChildren,
      numbered_list_item: { rich_text: [rt(text)], color: "default" },
    };
  }

  it("부모-자식 번호목록이 타입·텍스트·중첩 구조 그대로 왕복(번호→불릿 강등 없음)", async () => {
    const childrenMap: Record<string, Array<Record<string, unknown>>> = {
      p1: [num("c1", "하위 항목 A"), num("c2", "하위 항목 B")],
    };
    const mockClient = {
      blocks: {
        children: {
          list: async ({ block_id }: { block_id: string }) => ({
            results: childrenMap[block_id] ?? [],
            has_more: false,
            next_cursor: null,
          }),
        },
      },
    } as unknown as Client;

    const conv = new BlockConverter();
    conv.initNotionToMd(mockClient);

    const md = await conv.notionBlockArrayToMarkdown([num("p1", "상위 항목 1", true)]);
    const blocks = conv.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;

    // 상위는 번호목록 1개.
    expect(blocks).toHaveLength(1);
    const parent = blocks[0]!;
    expect(project(parent)).toEqual({ type: "numbered_list_item", text: "상위 항목 1" });

    // 자식 2개도 번호목록으로 보존(불릿 강등 없음) + 텍스트 일치.
    const parentPayload = parent.numbered_list_item as {
      children?: Array<Record<string, unknown>>;
    };
    const kids = parentPayload.children ?? [];
    expect(kids.map(project)).toEqual([
      { type: "numbered_list_item", text: "하위 항목 A" },
      { type: "numbered_list_item", text: "하위 항목 B" },
    ]);
  });
});
