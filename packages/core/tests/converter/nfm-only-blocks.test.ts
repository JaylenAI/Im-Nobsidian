import { describe, it, expect } from "vitest";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { BlockConverter } from "../../src/converter/block-converter.js";
import { TOC_MARKER, tocMarker, embedMarker } from "../../src/constants/markers.js";

/**
 * NFM 전용 태그 — Notion 이 **이름을 붙여** 내보내지만 마크다운 대응 표현이 없는 것들.
 *
 * `preserveUnknownBlocks` 는 익명 `<unknown …/>` 만 알아, 이름이 붙은 나머지는 볼트에
 * 원시 HTML 로 눌러앉았다(실측: `<embed>` 27개·2노트, `<unknown_mention>` 8개·8노트,
 * `<table_of_contents>` 3개·3노트). 편집뷰에 태그가 그대로 보이고, push 때는 Notion 이
 * 해석하지 못해 평문으로 박제된다.
 */
describe("NFM 전용 블록 보존", () => {
  const roundTrip = (raw: string) => obsidianToNotionEnhanced(notionEnhancedToObsidian(raw));

  describe("목차(table_of_contents)", () => {
    it("기본색은 무색 마커로 — 구버전 볼트·레거시 경로와 형식을 공유한다", () => {
      const pulled = notionEnhancedToObsidian("<table_of_contents/>");

      expect(pulled.trim()).toBe(TOC_MARKER);
      expect(roundTrip("<table_of_contents/>").trim()).toBe("<table_of_contents/>");
    });

    it("색을 실은 목차는 색까지 왕복한다", () => {
      const raw = `<table_of_contents color="gray"/>`;
      const pulled = notionEnhancedToObsidian(raw);

      expect(pulled.trim()).toBe(tocMarker("gray"));
      expect(pulled).not.toContain("<table_of_contents");
      expect(roundTrip(raw).trim()).toBe(raw);
    });

    it("인용(콜아웃 본문) 안에서도 마커로 바뀌고 되돌아온다", () => {
      const raw = `> <table_of_contents color="blue"/>`;
      expect(notionEnhancedToObsidian(raw)).toContain(tocMarker("blue"));
      expect(roundTrip(raw).trim()).toBe(raw);
    });

    it("색 마커도 legacy 블록 경로에서 table_of_contents 로 복원된다", () => {
      // 마커 형식이 넓어졌는데 읽는 쪽이 하나만 알면, 그 문서만 마커가 평범한
      // 문단으로 Notion 에 기록된다(P1 과 같은 "한쪽 경로 누락" 결함).
      const blocks = new BlockConverter().markdownToNotionBlocks(
        `# Title\n\n${tocMarker("gray")}\n\nBody`,
      ) as Array<Record<string, unknown>>;

      const toc = blocks.find((b) => b.type === "table_of_contents");
      expect(toc, "색 마커가 table_of_contents 로 복원되지 않음").toBeDefined();
      expect((toc!.table_of_contents as { color: string }).color).toBe("gray");
      expect(JSON.stringify(blocks)).not.toContain("im-nobsidian:toc");
    });
  });

  describe("임베드(embed)", () => {
    const RAW = `<embed src="https://youtu.be/abc?t=1&x=2"></embed>`;

    it("클릭 가능한 링크 + 권위 마커 한 쌍으로 내려온다", () => {
      const pulled = notionEnhancedToObsidian(RAW).trim();

      // 마커만 남기면 읽기뷰에서 빈 줄로 보여 사용자가 소실로 오해한다
      expect(pulled).toContain("[🔗 Embed](https://youtu.be/abc?t=1&x=2)");
      expect(pulled).toContain(embedMarker("https://youtu.be/abc?t=1&x=2"));
      expect(pulled).not.toContain("<embed");
      // 링크와 마커는 공백 없이 인접 — push 가 한 쌍으로 소비한다
      expect(pulled).toBe(
        `[🔗 Embed](https://youtu.be/abc?t=1&x=2)${embedMarker("https://youtu.be/abc?t=1&x=2")}`,
      );
    });

    it("push 가 링크 잔해 없이 원본 태그로 되돌린다", () => {
      const pushed = roundTrip(RAW).trim();

      expect(pushed).toBe(RAW);
      expect(pushed).not.toContain("🔗 Embed");
    });

    it("URL 안 괄호가 링크 짝 경계를 앞당겨 끊지 않는다", () => {
      // 날 괄호를 그대로 두면 `\([^)]*\)` 가 `a(b` 에서 끊겨 링크 잔해가 Notion
      // 본문에 평문으로 박제된다. 목적지에서만 %28/%29 로 인코딩해 경계를 지킨다.
      const raw = `<embed src="https://ex.com/a(b)c"></embed>`;
      const pulled = notionEnhancedToObsidian(raw);

      expect(pulled).toContain("(https://ex.com/a%28b%29c)");
      expect(roundTrip(raw).trim()).toBe(raw);
    });

    it("들여쓴 임베드는 깊이를 잃지 않는다", () => {
      const raw = `\t<embed src="https://ex.com/x"></embed>`;
      expect(roundTrip(raw)).toContain(`\t<embed src="https://ex.com/x"></embed>`);
    });
  });

  describe("인라인 멘션(unknown_mention)", () => {
    // 실측: 커스텀 이모지 멘션이 제목 앞에 붙어 `## <unknown_mention …/>노시언` 으로 온다.
    const RAW = `## <unknown_mention url="notion://custom_emoji/06ff8ca3/241f9d07" alt="custom_emoji"/>노시언`;

    it("제목 안에서도 마커로 바뀌고 뒤 텍스트가 붙어 있다", () => {
      const pulled = notionEnhancedToObsidian(RAW).trim();

      expect(pulled).not.toContain("<unknown_mention");
      expect(pulled).toMatch(/^## %%im-nobsidian:unknown-mention:url=/);
      expect(pulled.endsWith("노시언")).toBe(true);
    });

    it("url·alt 가 모두 왕복한다", () => {
      expect(roundTrip(RAW).trim()).toBe(RAW);
    });

    it("alt 없는 멘션은 alt 를 날조하지 않는다", () => {
      const raw = `<unknown_mention url="notion://x/y"/>`;
      const pushed = roundTrip(raw).trim();

      expect(pushed).toBe(raw);
      expect(pushed).not.toContain("alt=");
    });
  });

  it("세 태그가 섞인 문서에서 원시 태그가 볼트로 새지 않는다", () => {
    const raw = [
      `<table_of_contents color="gray"/>`,
      ``,
      `<embed src="https://ex.com/v"></embed>`,
      ``,
      `본문 <unknown_mention url="notion://e/1" alt="custom_emoji"/> 사이`,
    ].join("\n");

    const pulled = notionEnhancedToObsidian(raw);
    expect(pulled).not.toMatch(/<(?:table_of_contents|embed|unknown_mention)\b/);
    // 본문은 그대로 살아 있다
    expect(pulled).toContain("본문 ");
    expect(pulled).toContain(" 사이");

    const pushed = obsidianToNotionEnhanced(pulled);
    expect(pushed).toContain(`<table_of_contents color="gray"/>`);
    expect(pushed).toContain(`<embed src="https://ex.com/v"></embed>`);
    expect(pushed).toContain(`<unknown_mention url="notion://e/1" alt="custom_emoji"/>`);
  });
});
