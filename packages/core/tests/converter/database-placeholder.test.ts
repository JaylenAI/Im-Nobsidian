/**
 * NFM <database> 태그 → placeholder 변환이 databaseId 를 보존 마커로 남기는지 (F22).
 *
 * 결함: 기존 변환은 `**제목** *(Notion DB)*` 텍스트만 남겨 ID 가 소실 — pull 후처리가
 * 어느 .base 로 임베드를 재작성해야 할지 알 수 없었다. 마커가 있어야
 * db-placeholder-rewriter 가 동작하고, 폴백 발견 경로(extractInlineDbIds)도 이를 재활용한다.
 */
import { describe, it, expect } from "vitest";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";

const ID = "23113b18d38280f984a5c9f9161ee659";

describe("convertDatabaseBlocks 마커 보존 (F22)", () => {
  it("app.notion.com/p 형 url 에서 id 를 뽑아 마커로 부착한다", () => {
    const src = `<database url="https://app.notion.com/p/${ID}" inline="true" data-source-url="collection://23113b18-d382-80f9-84a5-c9f9161ee659">인박스</database>`;
    const out = notionEnhancedToObsidian(src);
    expect(out).toContain("**인박스** *(Notion DB)*");
    expect(out).toContain(
      `%%im-nobsidian:child-database:id=${ID}&title=${encodeURIComponent("인박스")}%%`,
    );
  });

  it("www.notion.so 형 url 도 동일하게 처리한다", () => {
    const src = `<database url="https://www.notion.so/${ID}" inline="true">스킬</database>`;
    const out = notionEnhancedToObsidian(src);
    expect(out).toContain(`%%im-nobsidian:child-database:id=${ID}&`);
  });

  it("url 없는 태그는 기존 placeholder 형식 그대로(마커 없음) — 회귀 없음", () => {
    const out = notionEnhancedToObsidian(`<database inline="true">이름뿐</database>`);
    expect(out).toContain("**이름뿐** *(Notion DB)*");
    expect(out).not.toContain("child-database");
  });

  it("빈 제목(linked view)도 마커는 남는다", () => {
    const out = notionEnhancedToObsidian(
      `<database url="https://app.notion.com/p/${ID}" inline="true"></database>`,
    );
    expect(out).toContain("**** *(Notion DB)*");
    expect(out).toContain(`child-database:id=${ID}`);
  });
});
