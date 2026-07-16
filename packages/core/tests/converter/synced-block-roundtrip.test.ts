import { describe, it, expect } from "vitest";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";

// 실측 근거: NFM raw 의 <synced_block>(원본)/<synced_block_reference>(참조) 태그를
// replace_content 로 되밀면 참조가 완전 보존된다(블록 타입·synced_from 유지).
// pull 이 태그를 폐기하면 push 때 일반 블록으로 박제되므로, 마커 쌍으로 보존해야 한다.

const REF_URL =
  "https://app.notion.com/p/36f13b18d38280369350e839fd7880d2#0c613b18d38282c1b3a981d2994bcc26";

// Service 페이지 raw 1~5행 실측 축약본
const RAW_REF = `<synced_block_reference url="${REF_URL}">
	<callout color="gray_bg">
		[Home](/p/36f13b18?pvs=25)  \\|  [Study](/p/87013b18?pvs=25)
	</callout>
</synced_block_reference>

본문 문단`;

const RAW_ORIG = `<synced_block url="${REF_URL}">
	동기화 원본 내용
	두 번째 줄
</synced_block>

다음 문단`;

describe("synced block 마커 왕복", () => {
  it("reference 태그 → 마커 쌍 (pull)", () => {
    const result = notionEnhancedToObsidian(RAW_REF);
    expect(result).toContain(
      `%%im-nobsidian:synced:start:kind=ref&url=${encodeURIComponent(REF_URL)}%%`,
    );
    expect(result).toContain("%%im-nobsidian:synced:end%%");
    expect(result).not.toContain("<synced_block_reference");
    // 내부 콘텐츠는 dedent 되어 자연 노출 (callout 은 후속 파이프라인이 변환)
    expect(result).toContain("Home");
  });

  it("원본 태그 → 마커 쌍 kind=orig (pull)", () => {
    const result = notionEnhancedToObsidian(RAW_ORIG);
    expect(result).toContain("synced:start:kind=orig");
    expect(result).toContain("동기화 원본 내용");
    expect(result).not.toContain("<synced_block");
  });

  it("마커 쌍 → 태그 복원 (push)", () => {
    const marker = `%%im-nobsidian:synced:start:kind=ref&url=${encodeURIComponent(REF_URL)}%%
내용 첫 줄
내용 둘째 줄
%%im-nobsidian:synced:end%%`;
    const result = obsidianToNotionEnhanced(marker);
    expect(result).toContain(`<synced_block_reference url="${REF_URL}">`);
    expect(result).toContain("</synced_block_reference>");
    // 규격: 태그 내부는 탭 들여쓰기
    expect(result).toContain("\t내용 첫 줄");
  });

  it("kind=orig 마커 → <synced_block> 복원 (push)", () => {
    const marker = `%%im-nobsidian:synced:start:kind=orig&url=${encodeURIComponent(REF_URL)}%%
원본 내용
%%im-nobsidian:synced:end%%`;
    const result = obsidianToNotionEnhanced(marker);
    expect(result).toContain(`<synced_block url="${REF_URL}">`);
    expect(result).toContain("</synced_block>");
  });

  it("왕복: raw → obsidian → raw 에서 태그·URL 보존", () => {
    const pulled = notionEnhancedToObsidian(RAW_REF);
    const pushed = obsidianToNotionEnhanced(pulled);
    expect(pushed).toContain(`<synced_block_reference url="${REF_URL}">`);
    expect(pushed).toContain("</synced_block_reference>");
    expect(pushed).not.toContain("%%im-nobsidian:synced");
  });

  it("url 없는 마커는 본문만 남긴다 (방어)", () => {
    const marker = `%%im-nobsidian:synced:start:kind=ref&url=%%
내용
%%im-nobsidian:synced:end%%`;
    const result = obsidianToNotionEnhanced(marker);
    expect(result).not.toContain("<synced_block");
    expect(result).toContain("내용");
  });

  it("복수 synced 블록 독립 처리", () => {
    const raw = `${RAW_ORIG}\n\n${RAW_REF}`;
    const pulled = notionEnhancedToObsidian(raw);
    const starts = pulled.match(/synced:start/g);
    const ends = pulled.match(/synced:end/g);
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    const pushed = obsidianToNotionEnhanced(pulled);
    expect(pushed).toContain("<synced_block url=");
    expect(pushed).toContain("<synced_block_reference url=");
  });
});
