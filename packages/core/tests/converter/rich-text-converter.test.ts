import { describe, it, expect } from "vitest";
import {
  richTextToPlain,
  richTextToMarkdown,
  formatMention,
} from "../../src/converter/rich-text-converter.js";
import type { RichTextAnnotated } from "../../src/converter/rich-text-converter.js";

describe("rich-text-converter", () => {
  describe("richTextToPlain", () => {
    it("undefined → 빈 문자열", () => {
      expect(richTextToPlain(undefined)).toBe("");
    });

    it("여러 조각의 plain_text 를 이어붙임", () => {
      expect(richTextToPlain([{ plain_text: "가" }, { plain_text: "나" }])).toBe("가나");
    });
  });

  describe("richTextToMarkdown — 인라인 서식", () => {
    it("굵게·기울임·코드·취소선·밑줄", () => {
      const rt: RichTextAnnotated[] = [
        { plain_text: "b", annotations: { bold: true } },
        { plain_text: "i", annotations: { italic: true } },
        { plain_text: "c", annotations: { code: true } },
        { plain_text: "s", annotations: { strikethrough: true } },
        { plain_text: "u", annotations: { underline: true } },
      ];
      expect(richTextToMarkdown(rt)).toBe("**b***i*`c`~~s~~<u>u</u>");
    });

    it("링크는 [text](href)", () => {
      expect(richTextToMarkdown([{ plain_text: "구글", href: "https://google.com" }])).toBe(
        "[구글](https://google.com)",
      );
    });

    // rank15(I3): block-API 폴백 경로(richTextToMarkdown)의 color 출력이 코드베이스 정본인
    // 압축형 마커(`%%im-nobsidian:color:red%%text%%/color%%`)와 정확히 일치해야 한다.
    // 과거엔 공백형(`%% im-nobsidian:color:red %%text%% im-nobsidian:end %%`)을 내보내
    // enhanced-md-converter 의 restoreColorSpans(압축형 전용) 정규식에 미매칭 → 블록 폴백
    // 산출 색상이 push 시 silent 손실됐다. 부분일치(toContain) 가 아닌 전체 문자열 toBe 로 잠근다.
    it("색상은 압축형 보존 마커로 정확히 감싼다(블록 폴백 정본 일치)", () => {
      const out = richTextToMarkdown([{ plain_text: "빨강", annotations: { color: "red" } }]);
      expect(out).toBe("%%im-nobsidian:color:red%%빨강%%/color%%");
    });

    it("default 색상은 마커를 붙이지 않는다", () => {
      const out = richTextToMarkdown([{ plain_text: "보통", annotations: { color: "default" } }]);
      expect(out).toBe("보통");
    });

    it("인라인 수식은 $expr$", () => {
      const out = richTextToMarkdown([
        { plain_text: "", type: "equation", equation: { expression: "a^2" } },
      ]);
      expect(out).toBe("$a^2$");
    });
  });

  describe("formatMention — 멘션 환원 + 미처리 타입 보존", () => {
    it("page 멘션 → 위키링크(id)", () => {
      expect(formatMention({ type: "page", page: { id: "abc" } }, "제목")).toBe("[[abc]]");
    });

    it("database 멘션 → 위키링크(id)", () => {
      expect(formatMention({ type: "database", database: { id: "db1" } }, "DB")).toBe("[[db1]]");
    });

    it("date 멘션 — 시작/종료", () => {
      expect(formatMention({ type: "date", date: { start: "2026-05-30" } }, "")).toBe("2026-05-30");
      expect(
        formatMention({ type: "date", date: { start: "2026-05-01", end: "2026-05-30" } }, ""),
      ).toBe("2026-05-01 → 2026-05-30");
    });

    it("user 멘션 — 이름 있으면 @이름, 없으면 plainText 폴백", () => {
      expect(formatMention({ type: "user", user: { id: "u", name: "한승헌" } }, "")).toBe(
        "@한승헌",
      );
      expect(formatMention({ type: "user", user: { id: "u" } }, "@익명")).toBe("@익명");
    });

    it("link_preview 등 미처리 멘션은 plain_text 로 보존(빈 문자열 소실 방지)", () => {
      // 기존엔 default → "" 로 본문이 통째 소실됐다. 이제 Notion 이 주는 plain_text 로 보존.
      expect(formatMention({ type: "link_preview" }, "https://example.com/preview")).toBe(
        "https://example.com/preview",
      );
      expect(formatMention({ type: "template_mention" }, "@오늘")).toBe("@오늘");
    });

    it("richTextToMarkdown 안에서도 미처리 멘션이 보존된다", () => {
      const out = richTextToMarkdown([
        { plain_text: "앞 " },
        { plain_text: "https://link.example", type: "mention", mention: { type: "link_preview" } },
        { plain_text: " 뒤" },
      ]);
      expect(out).toBe("앞 https://link.example 뒤");
    });
  });
});
