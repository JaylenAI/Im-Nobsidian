/**
 * ADR-008 NFM 디자인 충실도 왕복 테스트.
 *
 * 픽스처는 2026-07-16 실 Notion 프로브(__p4_design__)에서 실측한 NFM raw 정준형:
 * - 컬럼: `<columns>` + 탭 들여쓴 `<column>` 자식
 * - 콜아웃: `<callout icon="⚠️" color="red_bg">` — 아이콘은 본문이 아니라 속성
 * - 색상 토글: `<details color="green_bg">`
 * - 블록 색: 줄 끝 `{color="red"}` (문단/제목/리스트/인용 공통)
 *
 * 목표: pull(정준형) → push 가 정준형으로 수렴(무손실), 마커 리터럴 Notion 누수 금지.
 */
import { describe, it, expect } from "vitest";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { COLUMN_LIST_START, COLUMN_LIST_END, COLUMN_SEP } from "../../src/constants/markers.js";

/** pull → push 왕복 결과 (Notion 정준형 수렴 검증용) */
function roundtrip(canonical: string): { pulled: string; pushed: string } {
  const pulled = notionEnhancedToObsidian(canonical);
  const pushed = obsidianToNotionEnhanced(pulled);
  return { pulled, pushed };
}

describe("컬럼 레이아웃 (ADR-008)", () => {
  const CANONICAL = [
    "<columns>",
    "\t<column>",
    "\t\t칼럼A 첫 문단",
    "",
    "\t\t칼럼A 둘째 문단",
    "\t</column>",
    "\t<column>",
    "\t\t칼럼B 문단",
    "\t</column>",
    "</columns>",
  ].join("\n");

  it("pull: 컬럼을 legacy block 경로와 동일한 마커 어휘로 감싼다", () => {
    const pulled = notionEnhancedToObsidian(CANONICAL);

    expect(pulled).toContain(COLUMN_LIST_START);
    expect(pulled).toContain(COLUMN_SEP);
    expect(pulled).toContain(COLUMN_LIST_END);
    expect(pulled).toContain("칼럼A 첫 문단");
    expect(pulled).toContain("칼럼B 문단");
    // 태그는 남지 않는다
    expect(pulled).not.toContain("<columns");
    expect(pulled).not.toContain("<column>");
  });

  it("push: 마커 영역을 정준형 <columns>/<column> 태그로 재조립한다", () => {
    const { pushed } = roundtrip(CANONICAL);

    expect(pushed.trimEnd()).toBe(CANONICAL);
    expect(pushed).not.toContain("%%im-nobsidian:column");
  });

  it("push: 순서가 어긋난 잔여 컬럼 마커는 줄째 제거된다 (Notion 누수 금지)", () => {
    const stray = [
      "문단 하나",
      COLUMN_SEP,
      "> 인용 안 마커",
      `> ${COLUMN_LIST_START}`,
      "끝 문단",
    ].join("\n");
    const pushed = obsidianToNotionEnhanced(stray);

    expect(pushed).not.toContain("%%im-nobsidian:column");
    expect(pushed).toContain("문단 하나");
    expect(pushed).toContain("끝 문단");
  });

  it("컨테이너-중첩 컬럼은 pull 때 마커 없이 평탄화된다 (degrade)", () => {
    const nested = [
      '<callout icon="⚠️">',
      "\t제목줄",
      "\t<columns>",
      "\t\t<column>",
      "\t\t\t중첩 칼럼A",
      "\t\t</column>",
      "\t\t<column>",
      "\t\t\t중첩 칼럼B",
      "\t\t</column>",
      "\t</columns>",
      "</callout>",
    ].join("\n");
    const { pulled, pushed } = roundtrip(nested);

    // quote prefix 가 붙은 컬럼 마커는 재조립 불가 → 걷어내고 내용만 평탄화
    expect(pulled).not.toContain("%%im-nobsidian:column");
    expect(pulled).toContain("중첩 칼럼A");
    expect(pulled).toContain("중첩 칼럼B");
    // push 산출물에도 마커 리터럴이 새지 않는다
    expect(pushed).not.toContain("%%im-nobsidian:column");
  });
});

describe("콜아웃 아이콘/색 (ADR-008)", () => {
  it("icon+color 왕복: 스타일 마커로 실어 정준형 속성으로 재조립", () => {
    const canonical = ['<callout icon="🔥" color="yellow_bg">', "\t불꽃 본문", "</callout>"].join(
      "\n",
    );
    const { pulled, pushed } = roundtrip(canonical);

    expect(pulled).toContain("> [!danger] 불꽃 본문");
    expect(pulled).toContain("%%im-nobsidian:callout-style:icon=%F0%9F%94%A5&color=yellow_bg%%");
    expect(pushed).toContain('<callout icon="🔥" color="yellow_bg">');
    expect(pushed).toContain("\t불꽃 본문");
    // 아이콘이 본문 텍스트로 새면 Notion 에 리터럴로 박제된다(실측) — 금지
    expect(pushed).not.toContain("🔥 불꽃");
  });

  it("type 기본 아이콘 + 무색: 마커 없이 원문 수렴 (볼트 노이즈 제거)", () => {
    const canonical = ['<callout icon="⚠️">', "\t경고 본문", "</callout>"].join("\n");
    const { pulled, pushed } = roundtrip(canonical);

    expect(pulled.trim()).toBe("> [!warning] 경고 본문");
    expect(pulled).not.toContain("callout-style");
    expect(pushed.trimEnd()).toBe(canonical);
  });

  it("아이콘 없는 색 콜아웃: 마커에 icon 을 싣지 않고 push 도 icon 속성을 만들지 않는다", () => {
    const canonical = ['<callout color="blue_bg">', "\t아이콘 없는 파란 콜아웃", "</callout>"].join(
      "\n",
    );
    const { pulled, pushed } = roundtrip(canonical);

    expect(pulled).toContain("%%im-nobsidian:callout-style:color=blue_bg%%");
    expect(pulled).not.toContain("icon=");
    expect(pushed).toContain('<callout color="blue_bg">');
    expect(pushed).not.toContain("icon=");
  });

  it("타입 미매핑 이모지 아이콘도 마커로 보존된다", () => {
    const canonical = ['<callout icon="🎉">', "\t파티 본문", "</callout>"].join("\n");
    const { pulled, pushed } = roundtrip(canonical);

    // 🎉 는 EMOJI_TYPE_MAP 에 없어 type 은 note 로 degrade — 아이콘은 마커가 지킨다
    expect(pulled).toContain("> [!note] 파티 본문");
    expect(pulled).toContain(`icon=${encodeURIComponent("🎉")}`);
    expect(pushed).toContain('<callout icon="🎉">');
  });

  it("본문 첫 줄이 이모지로 시작해도 icon/color 속성이 있으면 본문으로 지킨다", () => {
    const canonical = [
      '<callout color="blue_bg">',
      "\t💡 본문이지 아이콘이 아님",
      "</callout>",
    ].join("\n");
    const { pulled, pushed } = roundtrip(canonical);

    expect(pulled).toContain("💡 본문이지 아이콘이 아님");
    expect(pushed).toContain("💡 본문이지 아이콘이 아님");
    expect(pushed).not.toContain('icon="💡"');
  });

  it("마커 없는 사용자 작성 콜아웃: type→이모지를 icon 속성으로 (본문 오염 금지)", () => {
    const pushed = obsidianToNotionEnhanced("> [!tip] 사용자 팁\n> 본문입니다.");

    expect(pushed).toContain('<callout icon="💡">');
    expect(pushed).toContain("\t사용자 팁");
    expect(pushed).toContain("\t본문입니다.");
    expect(pushed).not.toContain("💡 사용자 팁");
    expect(pushed).not.toContain("::: callout");
  });

  it("중첩 콜아웃은 태그 중첩으로 재귀 왕복된다", () => {
    const obsidian = ["> [!warning] 바깥", "> 바깥 본문", "> > [!tip] 안쪽", "> > 안쪽 본문"].join(
      "\n",
    );
    const pushed = obsidianToNotionEnhanced(obsidian);

    expect(pushed).toContain('<callout icon="⚠️">');
    expect(pushed).toContain('\t<callout icon="💡">');
    expect(pushed).toContain("\t\t안쪽 본문");
    // 내부 헤드가 리터럴로 새지 않는다
    expect(pushed).not.toContain("[!tip]");

    const back = notionEnhancedToObsidian(pushed);
    expect(back).toContain("> [!warning] 바깥");
    expect(back).toContain("> > [!tip] 안쪽");
    expect(back).toContain("> > 안쪽 본문");
  });

  it("legacy `::: callout` 펜스 pull 경로 유지 (기본 이모지 → 마커 없이)", () => {
    const legacy = "::: callout\n⚠️ 주의 제목\n본문 줄\n:::";
    const pulled = notionEnhancedToObsidian(legacy);

    expect(pulled).toContain("> [!warning] 주의 제목");
    expect(pulled).toContain("> 본문 줄");
    expect(pulled).not.toContain("callout-style");
  });

  it("legacy 펜스의 미매핑 이모지는 마커로 승격돼 아이콘이 살아남는다", () => {
    const legacy = "::: callout\n🎉 파티 제목\n:::";
    const pulled = notionEnhancedToObsidian(legacy);
    const pushed = obsidianToNotionEnhanced(pulled);

    expect(pulled).toContain("> [!note] 파티 제목");
    expect(pushed).toContain('<callout icon="🎉">');
  });
});

describe("색상 토글 (ADR-008)", () => {
  it("<details color> 왕복: toggle-color 마커로 실어 속성 재조립", () => {
    const canonical = [
      '<details color="green_bg">',
      "<summary>초록 토글</summary>",
      "\t토글 본문",
      "</details>",
    ].join("\n");
    const { pulled, pushed } = roundtrip(canonical);

    expect(pulled).toContain("> [!toggle]- 초록 토글 %%im-nobsidian:toggle-color:green_bg%%");
    expect(pulled).toContain("> 토글 본문");
    expect(pushed).toContain('<details color="green_bg">');
    expect(pushed).toContain("<summary>초록 토글</summary>");
    expect(pushed).not.toContain("toggle-color");
  });

  it("무색 토글은 마커 없이 기존과 동일", () => {
    const canonical = ["<details>", "<summary>일반 토글</summary>", "\t본문", "</details>"].join(
      "\n",
    );
    const { pulled, pushed } = roundtrip(canonical);

    expect(pulled).toContain("> [!toggle]- 일반 토글");
    expect(pulled).not.toContain("toggle-color");
    expect(pushed).toContain("<details>");
    expect(pushed).not.toContain('color="');
  });
});

describe("블록 색 (ADR-008)", () => {
  it("문단/제목/리스트/인용 줄 끝 {color} 4형태 왕복", () => {
    const canonical = [
      '빨간 문단 {color="red"}',
      "",
      '## 주황 제목 {color="orange"}',
      "",
      '- 보라 리스트 {color="purple"}',
      "",
      '> 회색배경 인용 {color="gray_bg"}',
    ].join("\n");
    const { pulled, pushed } = roundtrip(canonical);

    // pull: Obsidian 에서 안 보이는 주석 마커로
    expect(pulled).toContain("빨간 문단 %%im-nobsidian:block-color:red%%");
    expect(pulled).toContain("## 주황 제목 %%im-nobsidian:block-color:orange%%");
    expect(pulled).toContain("- 보라 리스트 %%im-nobsidian:block-color:purple%%");
    expect(pulled).toContain("> 회색배경 인용 %%im-nobsidian:block-color:gray_bg%%");
    expect(pulled).not.toContain("{color=");

    // push: 정준형 복원
    expect(pushed).toContain('빨간 문단 {color="red"}');
    expect(pushed).toContain('## 주황 제목 {color="orange"}');
    expect(pushed).toContain('- 보라 리스트 {color="purple"}');
    expect(pushed).toContain('> 회색배경 인용 {color="gray_bg"}');
    expect(pushed).not.toContain("block-color");
  });

  it("줄 중간의 {color} 는 블록 색이 아니므로 마커화하지 않는다", () => {
    const pulled = notionEnhancedToObsidian('중간 {color="red"} 텍스트');

    expect(pulled).not.toContain("block-color");
    expect(pulled).not.toContain("{color=");
  });
});

describe("디자인 요소 복합 문서 수렴", () => {
  it("컬럼+콜아웃+토글+블록색 혼합 정준형이 한 번의 왕복으로 수렴한다", () => {
    const canonical = [
      "기준 문단",
      "",
      "<columns>",
      "\t<column>",
      '\t\t<callout icon="⚠️" color="red_bg">',
      "\t\t\t칼럼 안 경고",
      "\t\t</callout>",
      "\t</column>",
      "\t<column>",
      "\t\t칼럼B 문단",
      "\t</column>",
      "</columns>",
      "",
      '<details color="green_bg">',
      "<summary>초록 토글</summary>",
      "\t토글 본문",
      "</details>",
      "",
      '마무리 문단 {color="blue"}',
    ].join("\n");

    const first = roundtrip(canonical);
    const second = roundtrip(first.pushed);

    // 1차 왕복에서 디자인 정보가 전부 살아남는다
    expect(first.pushed).toContain('<callout icon="⚠️" color="red_bg">');
    expect(first.pushed).toContain('<details color="green_bg">');
    expect(first.pushed).toContain('마무리 문단 {color="blue"}');
    expect(first.pushed).toContain("<columns>");
    expect(first.pushed).toContain("\t<column>");
    // 2차 왕복은 1차와 동일 (수렴 — 반복 sync 에도 드리프트 없음)
    expect(second.pushed).toBe(first.pushed);
  });
});
