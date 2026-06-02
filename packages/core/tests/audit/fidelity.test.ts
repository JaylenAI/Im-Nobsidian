import { describe, expect, it } from "vitest";
import { classifyBodyFidelity, summarizeFidelity } from "../../src/audit/index.js";

// 실제 Im-Nobsidian-Test 코퍼스에서 관측된 id (M6 회귀 가드와 동일 출처).
const AI_ENGINEER = "36f13b18d382806587b2e8b7ccb303bc";
const STUDY = "a7713b18d38282c292ab8158f069bd7f";
const SELF = "35a13b18d382801aae15c1234567890a";
const EXTERNAL = "ffffffffffffffffffffffffffffffff"; // 코퍼스 밖

const ctx = {
  knownPageIds: new Set([AI_ENGINEER, STUDY, SELF]),
  titleById: new Map([
    [AI_ENGINEER, "AI Engineer (1)"],
    [STUDY, "Study"],
    [SELF, "Self Page"],
  ]),
  ownPageId: SELF,
};

describe("classifyBodyFidelity — 충실도 분류기", () => {
  it("보존 마커 동반 링크는 결함이 아니라 preservedMarkers 로 분류", () => {
    // copy_indicator 실제 형태: 가시 링크 + 직후 압축형 보존 마커
    const body = `[🔗 copy_indicator](https://www.notion.so/${AI_ENGINEER})%%im-nobsidian:unknown:abc&type=copy_indicator%%`;
    const r = classifyBodyFidelity(body, ctx);
    expect(r.preservedMarkers).toBe(1);
    expect(r.defects).toHaveLength(0);
    expect(r.externalLinks).toBe(0);
  });

  it("공백형 보존 마커도 preservedMarkers 로 인식", () => {
    const body = `[ref](https://notion.so/${STUDY}) %% im-nobsidian:wikilink/x %%`;
    const r = classifyBodyFidelity(body, ctx);
    expect(r.preservedMarkers).toBe(1);
    expect(r.defects).toHaveLength(0);
  });

  it("코퍼스 밖 외부 notion 링크는 externalLinks (정당)", () => {
    const body = `자세히는 [외부문서](https://www.notion.so/${EXTERNAL}) 참고`;
    const r = classifyBodyFidelity(body, ctx);
    expect(r.externalLinks).toBe(1);
    expect(r.defects).toHaveLength(0);
  });

  it("자기 자신 페이지로의 맨 링크는 selfReferences (블록앵커 등, 정당)", () => {
    const body = `[여기](https://www.notion.so/${SELF}#block-anchor)`;
    const r = classifyBodyFidelity(body, ctx);
    expect(r.selfReferences).toBe(1);
    expect(r.defects).toHaveLength(0);
  });

  it("코퍼스 내 다른 페이지로의 맨 링크는 진짜 결함(md-link)", () => {
    const body = `관련 [[?]] [AI Engineer (1)](https://www.notion.so/${AI_ENGINEER})`;
    const r = classifyBodyFidelity(body, ctx);
    expect(r.defects).toHaveLength(1);
    expect(r.defects[0]?.form).toBe("md-link");
    expect(r.defects[0]?.targetPageId).toBe(AI_ENGINEER);
    expect(r.defects[0]?.targetTitle).toBe("AI Engineer (1)");
  });

  it("라벨 동반형 mention-page 잔류물은 진짜 결함(mention-page) — M6 회귀 가드", () => {
    const body = `> [!note] <mention-page url="https://www.notion.so/${AI_ENGINEER}">AI Engineer (1)</mention-page>`;
    const r = classifyBodyFidelity(body, ctx);
    expect(r.defects).toHaveLength(1);
    expect(r.defects[0]?.form).toBe("mention-page");
    expect(r.defects[0]?.targetPageId).toBe(AI_ENGINEER);
  });

  it("self-closing mention-page 잔류물도 결함으로 검출", () => {
    const body = `<mention-page url="https://www.notion.so/${STUDY}"/>`;
    const r = classifyBodyFidelity(body, ctx);
    expect(r.defects).toHaveLength(1);
    expect(r.defects[0]?.form).toBe("mention-page");
    expect(r.defects[0]?.targetPageId).toBe(STUDY);
  });

  it("정상 변환 결과(위키링크/보존마커만)는 결함 0 — 무손실 상태", () => {
    const body = [
      "---",
      "title: Study",
      "related:",
      '  - "[[AI Engineer (1)]]"',
      "---",
      "본문 [[AI Engineer (1)]] 과 [[ETC]] 위키링크.",
      `[🔗 copy_indicator](https://www.notion.so/${SELF})%%im-nobsidian:unknown:x&type=copy_indicator%%`,
    ].join("\n");
    const r = classifyBodyFidelity(body, ctx);
    expect(r.defects).toHaveLength(0);
    expect(r.preservedMarkers).toBe(1); // copy_indicator 는 마커 동반 → preservedMarkers (self-ref 보다 우선)
    expect(r.selfReferences).toBe(0);
  });

  it("한 줄 다중 라벨형 모두 개별 결함으로 검출 (lazy 과잉소비 방지 가드)", () => {
    const body = `<mention-page url="https://www.notion.so/${AI_ENGINEER}">AI Engineer</mention-page> | <mention-page url="https://www.notion.so/${STUDY}">Study</mention-page>`;
    const r = classifyBodyFidelity(body, ctx);
    expect(r.defects).toHaveLength(2);
    expect(r.defects.map((d) => d.targetPageId).sort()).toEqual([AI_ENGINEER, STUDY].sort());
  });

  it("titleById 없이도 결함 검출은 동작(targetTitle=null)", () => {
    const r = classifyBodyFidelity(
      `<mention-page url="https://www.notion.so/${AI_ENGINEER}">x</mention-page>`,
      { knownPageIds: new Set([AI_ENGINEER]) },
    );
    expect(r.defects).toHaveLength(1);
    expect(r.defects[0]?.targetTitle).toBeNull();
  });
});

describe("summarizeFidelity — 코퍼스 합산", () => {
  it("파일별 분류를 합산하고 결함 파일만 defectsByFile 에 기록", () => {
    const clean = classifyBodyFidelity(`[[AI Engineer (1)]] 정상`, ctx);
    const broken = classifyBodyFidelity(
      `<mention-page url="https://www.notion.so/${STUDY}">Study</mention-page>`,
      ctx,
    );
    const summary = summarizeFidelity([
      { path: "Clean.md", classification: clean },
      { path: "Broken.md", classification: broken },
    ]);
    expect(summary.files).toBe(2);
    expect(summary.defects).toBe(1);
    expect(Object.keys(summary.defectsByFile)).toEqual(["Broken.md"]);
    expect(summary.defectsByFile["Broken.md"]).toHaveLength(1);
  });

  it("결함 0 코퍼스는 defectsByFile 가 비어 있음", () => {
    const a = classifyBodyFidelity(`[[X]]`, ctx);
    const summary = summarizeFidelity([{ path: "A.md", classification: a }]);
    expect(summary.defects).toBe(0);
    expect(Object.keys(summary.defectsByFile)).toHaveLength(0);
  });
});
