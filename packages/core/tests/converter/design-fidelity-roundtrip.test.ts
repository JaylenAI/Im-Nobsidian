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

// R8 D-EMPTY-COLUMN: 빈 칼럼을 "내용이 없다"는 이유로 걷어내던 탓에 3열 레이아웃이
// pull 에서 2열로 접히고, 그 상태로 push 하면 **사용자의 Notion 열 구성 자체가 좁아졌다**.
// 빈 칼럼은 여백을 담당하는 실제 구성요소이므로 자리를 지켜야 한다.
describe("빈 칼럼 보존 (R8)", () => {
  const THREE_WITH_HOLE = [
    "<columns>",
    "\t<column>",
    "\t\t왼쪽",
    "\t</column>",
    "\t<column>",
    "\t</column>",
    "\t<column>",
    "\t\t오른쪽",
    "\t</column>",
    "</columns>",
  ].join("\n");

  it("가운데가 빈 3열은 pull 에서 마커 3개로 남는다", () => {
    const pulled = notionEnhancedToObsidian(THREE_WITH_HOLE);

    expect((pulled.match(new RegExp(COLUMN_SEP, "g")) ?? []).length).toBe(3);
    expect(pulled).toContain("왼쪽");
    expect(pulled).toContain("오른쪽");
  });

  it("push 재조립도 3열을 유지한다 (레이아웃 붕괴 금지)", () => {
    const { pushed } = roundtrip(THREE_WITH_HOLE);

    expect((pushed.match(/<column(?!s)/g) ?? []).length).toBe(3);
    expect(pushed).not.toContain("%%im-nobsidian:column");
  });

  it("두 번째 왕복에서도 열 개수가 그대로다 (수렴)", () => {
    const once = roundtrip(THREE_WITH_HOLE).pushed;
    const twice = roundtrip(once).pushed;

    expect(twice.trimEnd()).toBe(once.trimEnd());
    expect((twice.match(/<column(?!s)/g) ?? []).length).toBe(3);
  });

  it("칼럼이 전부 비면 레이아웃째 사라진다 (담은 내용이 없음)", () => {
    const allEmpty = [
      "<columns>",
      "\t<column>",
      "\t</column>",
      "\t<column>",
      "\t</column>",
      "</columns>",
    ].join("\n");
    const { pulled, pushed } = roundtrip(allEmpty);

    expect(pulled.trim()).toBe("");
    expect(pushed).not.toContain("<column");
  });

  it("마커를 칼럼 **사이 구분자**로 쓴 레거시 문서도 첫 칼럼을 잃지 않는다", () => {
    // 정준형(칼럼마다 마커 1개)에서는 split 의 첫 조각이 빈 잔여물이지만, 레거시
    // 구분자 표기에서는 그 조각이 진짜 첫 칼럼이다. 무조건 떨구면 "왼쪽"이 사라진다.
    const legacy = [COLUMN_LIST_START, "왼쪽", COLUMN_SEP, "오른쪽", COLUMN_LIST_END].join("\n");
    const pushed = obsidianToNotionEnhanced(legacy);

    expect((pushed.match(/<column(?!s)/g) ?? []).length).toBe(2);
    expect(pushed).toContain("왼쪽");
    expect(pushed).toContain("오른쪽");
  });
});

// R3 D-COLUMN-NEST: push 재조립이 비탐욕 한 방이라 바깥 START 가 안쪽 END 에서 닫혀
// 중첩 한 겹이 통째로 평탄화됐다(실볼트 `올인원 가계부 _Lite_` 마커 24→22 · `영화` 49→42).
// pull 쪽 INNERMOST_COLUMNS_RE 와 같은 "최내곽부터 반복" 관용으로 봉합한다.
describe("칼럼 중첩·들여쓰기 재조립 (R3)", () => {
  const NESTED = [
    "<columns>",
    "\t<column>",
    "\t\tA",
    "\t</column>",
    "\t<column>",
    "\t\t<columns>",
    "\t\t\t<column>",
    "\t\t\t\tB",
    "\t\t\t</column>",
    "\t\t\t<column>",
    "\t\t\t\tC",
    "\t\t\t</column>",
    "\t\t</columns>",
    "\t</column>",
    "</columns>",
  ].join("\n");

  it("칼럼 안 칼럼이 왕복해도 평탄화되지 않는다", () => {
    const { pulled, pushed } = roundtrip(NESTED);

    // pull: 안쪽·바깥쪽 모두 마커 쌍이 남는다
    expect(pulled.match(new RegExp(escape(COLUMN_LIST_START), "g"))).toHaveLength(2);
    expect(pulled.match(new RegExp(escape(COLUMN_LIST_END), "g"))).toHaveLength(2);
    expect(pulled.match(new RegExp(escape(COLUMN_SEP), "g"))).toHaveLength(4);
    // push: 정준형 계층이 그대로 복원된다
    expect(pushed.trim()).toBe(NESTED);
  });

  it("두 겹 왕복해도 고정점이다", () => {
    const once = roundtrip(NESTED).pushed;
    expect(roundtrip(once.trim()).pushed.trim()).toBe(NESTED);
  });

  // 실볼트 `영화.md`: 토글 헤딩(`### … {toggle="true"}`)의 자식 칼럼을 pull 이 4칸
  // 들여쓴 채 내보낸다. 열 0 만 매칭하던 시절엔 그 영역이 통째로 청소에 걷혀 위젯
  // 6개가 사라졌다 — 들여쓰기를 캡처해 재조립 결과에 다시 입힌다.
  it("들여쓴 칼럼 마커도 재조립되고 들여쓰기가 보존된다", () => {
    const indented = [
      "머리말",
      `    ${COLUMN_LIST_START}`,
      `    ${COLUMN_SEP}`,
      "    왼쪽",
      `    ${COLUMN_SEP}`,
      "    오른쪽",
      `    ${COLUMN_LIST_END}`,
    ].join("\n");

    const pushed = obsidianToNotionEnhanced(indented);

    expect(pushed).not.toContain("%%im-nobsidian:column");
    expect(pushed).toContain("    <columns>");
    expect(pushed).toContain("    \t<column>");
    expect(pushed).toContain("왼쪽");
    expect(pushed).toContain("오른쪽");
    // 들여쓰기째 왕복해도 마커 쌍이 살아 돌아온다
    expect(notionEnhancedToObsidian(pushed)).toContain(COLUMN_LIST_START);
  });
});

/** 정규식 리터럴로 쓰기 위한 마커 이스케이프(마커에는 `%` 만 특수문자가 아님). */
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

describe("P5 잔존 결함 회귀 (콜아웃-품은-컬럼 · URL 아이콘)", () => {
  // 실측 재현(인사이드 아웃): 콜아웃의 첫 자식이 컬럼이면 innermost 평탄화 순서상
  // start 마커가 콜아웃 본문 첫 줄 → 제목으로 흡수되어 줄 앵커 strip 을 벗어났다.
  const CALLOUT_WRAPPING_COLUMNS = [
    '<callout icon="⚠️" color="gray_bg">',
    "\t<columns>",
    "\t\t<column>",
    "\t\t\t왼쪽 내용",
    "\t\t</column>",
    "\t\t<column>",
    "\t\t\t오른쪽 내용",
    "\t\t</column>",
    "\t</columns>",
    "</callout>",
  ].join("\n");

  it("pull: 콜아웃 제목으로 흡수된 컬럼 start 마커도 걷어낸다 (평탄화 degrade)", () => {
    const pulled = notionEnhancedToObsidian(CALLOUT_WRAPPING_COLUMNS);

    expect(pulled).not.toContain("%%im-nobsidian:column");
    expect(pulled).toContain("왼쪽 내용");
    expect(pulled).toContain("오른쪽 내용");
    // 스타일 마커는 유지된다 (아이콘·색 보존)
    expect(pulled).toContain("callout-style");
  });

  it("push: 왕복해도 컬럼 마커 리터럴이 Notion 으로 새지 않는다", () => {
    const { pushed } = roundtrip(CALLOUT_WRAPPING_COLUMNS);

    expect(pushed).not.toContain("%%im-nobsidian:column");
    expect(pushed).toContain("왼쪽 내용");
  });

  it("v0.3.0 볼트 잔재(제목에 흡수된 마커 라인) push 시에도 누수가 없다", () => {
    // 구버전 pull 이 이미 만들어 둔 오염 라인 — push 안전망이 걷어야 한다
    const legacyVault = [
      "> [!note] %%im-nobsidian:column-list:start%% %%im-nobsidian:callout-style:color=gray_bg%%",
      ">",
      "> 본문 내용",
    ].join("\n");

    const pushed = obsidianToNotionEnhanced(legacyVault);
    expect(pushed).not.toContain("%%im-nobsidian:column");
    expect(pushed).toContain("본문 내용");
  });

  it("pull: 이중 중첩(콜아웃 안 콜아웃)의 구조적 탭이 남은 컬럼 마커도 걷어낸다", () => {
    // 실측(루틴 iOS 알림 버전): quote 프리픽스 소비는 `>`+공백 1개 단위라
    // `> > \t%%..%%` 의 탭이 남아 줄 앵커 규칙(EDGE/SEP)을 벗어났다.
    const nested = [
      '<callout icon="💡">',
      "\t바깥 콜아웃 제목",
      '\t<callout icon="💡">',
      "\t\t안쪽 콜아웃 제목",
      "\t\t<columns>",
      "\t\t\t<column>",
      "\t\t\t\t왼쪽",
      "\t\t\t</column>",
      "\t\t\t<column>",
      "\t\t\t\t오른쪽",
      "\t\t\t</column>",
      "\t\t</columns>",
      "\t</callout>",
      "</callout>",
    ].join("\n");

    const pulled = notionEnhancedToObsidian(nested);
    expect(pulled).not.toContain("%%im-nobsidian:column");
    expect(pulled).toContain("왼쪽");
    expect(pulled).toContain("오른쪽");

    const pushed = obsidianToNotionEnhanced(pulled);
    expect(pushed).not.toContain("%%im-nobsidian:column");
  });

  it("pull: 업로드 이미지(서명 URL) 아이콘은 마커에 싣지 않는다 — 색만 보존", () => {
    const canonical = [
      '<callout icon="https://prod-files-secure.s3.us-west-2.amazonaws.com/a/b/icon.png?X-Amz-Signature=deadbeef" color="gray_bg">',
      "\t제목 텍스트",
      "\t본문",
      "</callout>",
    ].join("\n");

    const pulled = notionEnhancedToObsidian(canonical);

    expect(pulled).not.toContain("prod-files-secure");
    expect(pulled).not.toContain("X-Amz");
    expect(pulled).not.toContain("icon=");
    expect(pulled).toContain("%%im-nobsidian:callout-style:color=gray_bg%%");
    expect(pulled).toContain("> [!note] 제목 텍스트");
  });

  it("pull: URL 아이콘 + 무색 콜아웃은 마커 없이 평문 콜아웃이 된다", () => {
    const canonical = [
      '<callout icon="https://file.notion.so/f/f/space/file/img.png?table=block&id=x">',
      "\t제목만",
      "</callout>",
    ].join("\n");

    const pulled = notionEnhancedToObsidian(canonical);

    expect(pulled).not.toContain("callout-style");
    expect(pulled).not.toContain("file.notion.so");
    expect(pulled).toContain("> [!note] 제목만");
  });

  it("URL 아이콘 콜아웃 왕복: 2차 왕복이 1차와 동일 (churn 0)", () => {
    const canonical = [
      '<callout icon="https://prod-files-secure.s3.us-west-2.amazonaws.com/a/b/icon.png?X-Amz-Signature=cafe" color="gray_bg">',
      "\t제목",
      "\t본문 줄",
      "</callout>",
    ].join("\n");

    const first = roundtrip(canonical);
    const second = roundtrip(first.pushed);

    expect(second.pushed).toBe(first.pushed);
    expect(first.pushed).not.toContain("X-Amz");
    // 마커의 icon 부재 → push 는 icon 속성을 채우지 않는다 (아이콘 없는 콜아웃 degrade)
    expect(first.pushed).toContain('<callout color="gray_bg">');
  });

  it("이모지 아이콘 콜아웃은 기존대로 마커에 실린다 (회귀 방지)", () => {
    const canonical = ['<callout icon="🔥" color="yellow_bg">', "\t제목", "</callout>"].join("\n");

    const pulled = notionEnhancedToObsidian(canonical);
    expect(pulled).toContain("icon=%F0%9F%94%A5");
    expect(pulled).toContain("color=yellow_bg");
  });
});
