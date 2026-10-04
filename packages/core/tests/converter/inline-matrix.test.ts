/**
 * I3 인라인 조합·중첩 span 라운드트립 잠금 (rank6) — 오프라인 결정론.
 *
 * 결함: notion→obsidian 의 span 변환이 **비탐욕 단일 정규식**(`<span ...>([\s\S]*?)</span>`)
 * 이라 중첩 span 에서 첫 `</span>` 에 멈춰 바깥 span 의 닫는 태그를 깨뜨렸다. 그 결과
 * `<span color><span underline>y</span></span>` 가 닫는 태그 1개를 잃은 채 환원돼 push 시
 * 구조가 파손됐다(I3 '인라인 조합 무손실' 위반).
 *
 * 수정: 안쪽(중첩 없는) span 부터 마커로 치환하는 **균형 매칭(innermost-first)** 으로 교체.
 * 마커는 `<span` 을 포함하지 않으므로 다음 패스에서 바깥 span 이 다시 innermost 가 된다 →
 * 임의 깊이 중첩을 정확히 처리한다.
 *
 * 본 테스트는 enhanced 중간형(`<span>` 포함) ↔ Obsidian 마커형 사이를
 *   pull(notionEnhancedToObsidian) → push(obsidianToNotionEnhanced) 로 왕복시켜
 * **원본 전체 문자열 toBe**(부분일치 금지) + Obsidian 측 마커 fixpoint(2회=1회) 를 잠근다.
 * 가드 유효성: 비탐욕 단일 정규식으로 되돌리면 중첩 케이스에서 닫는 태그 수가 어긋나 실패한다.
 */
import { describe, it, expect } from "vitest";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { formatMention } from "../../src/converter/rich-text-converter.js";

/** enhanced 중간형 → Obsidian 마커형 → 다시 enhanced 중간형 왕복. */
function roundtrip(notionForm: string): string {
  return obsidianToNotionEnhanced(notionEnhancedToObsidian(notionForm));
}

describe("I3 인라인 조합·중첩 span 라운드트립 (오프라인 결정론)", () => {
  it("단일 color span 왕복 보존", () => {
    const src = `<span color="red">빨강</span>`;
    expect(roundtrip(src)).toBe(src);
  });

  it("단일 underline span 왕복 보존", () => {
    const src = `<span underline="true">밑줄</span>`;
    expect(roundtrip(src)).toBe(src);
  });

  // ── 중첩 span 의 핵심 회귀: Obsidian **중간 마커형의 닫는 토큰 순서**를 직접 잠근다. ──
  // full 왕복(notion→obsidian→notion)은 비탐욕 restore 가 닫는 태그를 우연히 재조립해
  // 자기치유되므로 결함을 가린다. 진짜 손상은 사용자가 보는 Obsidian 파일의 마커 중첩이
  // 뒤집히는 것(`...%%/color%%%%/underline%%` ← 닫는 순서 오류)이다. 따라서 중간형을 단언한다.
  // 겹친 span 은 push 에서 한 태그로 펼친다 — Notion 은 span 안의 span 을 읽지 못하고 안쪽 닫는 태그를
  // 글자 `</span>` 로 남긴다(2026-10-04 실측). 그래서 왕복은 원문이 아니라 Notion 이 내보내는 모양이 된다.
  const COMBINED = `<span color="red" underline="true">`;

  it("color 바깥 / underline 안쪽 중첩 — 마커 닫는 순서가 올바르게 중첩된다", () => {
    const src = `<span color="red"><span underline="true">*y*</span></span>`;
    // 올바른 중첩: color 가 바깥 → 마지막에 닫힘(%%/color%% 가 %%/underline%% 뒤).
    expect(notionEnhancedToObsidian(src)).toBe(
      `%%im-nobsidian:color:red%%%%im-nobsidian:underline%%*y*%%/underline%%%%/color%%`,
    );
    expect(roundtrip(src)).toBe(`${COMBINED}*y*</span>`);
  });

  it("color 바깥 / 평문 underline 안쪽 — <u> 가 색 마커 안에 든다", () => {
    const src = `<span color="red"><span underline="true">y</span></span>`;
    expect(notionEnhancedToObsidian(src)).toBe(`%%im-nobsidian:color:red%%<u>y</u>%%/color%%`);
    expect(roundtrip(src)).toBe(`${COMBINED}y</span>`);
  });

  it("underline 바깥 / color 안쪽 중첩 — 마커 닫는 순서가 올바르게 중첩된다", () => {
    const src = `<span underline="true"><span color="red">y</span></span>`;
    // 올바른 중첩: underline 이 바깥 → 마지막에 닫힘.
    expect(notionEnhancedToObsidian(src)).toBe(
      `%%im-nobsidian:underline%%%%im-nobsidian:color:red%%y%%/color%%%%/underline%%`,
    );
    expect(roundtrip(src)).toBe(`${COMBINED}y</span>`);
  });

  it("안쪽 span 앞뒤 글은 바깥 속성만 단 태그로 나눈다 — 형제 · 세 겹도", () => {
    expect(
      obsidianToNotionEnhanced(
        `%%im-nobsidian:color:red%%앞 <u>가</u> 사이 <u>나</u> 뒤%%/color%%`,
      ),
    ).toBe(
      `<span color="red">앞 </span>${COMBINED}가</span><span color="red"> 사이 </span>` +
        `${COMBINED}나</span><span color="red"> 뒤</span>`,
    );
    expect(
      roundtrip(
        `<span color="red"><span underline="true"><span color="blue_bg">x</span></span></span>`,
      ),
    ).toBe(`<span color="blue_bg" underline="true">x</span>`);
  });

  it("같은 마커가 겹쳐도 안쪽 짝부터 맞춘다 — 빨강 글 안의 형광", () => {
    expect(
      obsidianToNotionEnhanced(
        "%%im-nobsidian:color:red%%빨강 %%im-nobsidian:color:yellow_bg%%형광%%/color%% 끝%%/color%%",
      ),
    ).toBe(
      '<span color="red">빨강 </span><span color="yellow_bg">형광</span><span color="red"> 끝</span>',
    );
  });

  it("코드 안의 겹친 span 은 예제 글자라 펼치지 않는다", () => {
    const fenced = '```html\n<span color="red"><span underline="true">x</span></span>\n```';
    expect(obsidianToNotionEnhanced(fenced)).toBe(fenced);
  });

  it("span 안에 비-span 인라인(<b>)이 있어도 보존", () => {
    const src = `<span color="red"><b>x</b></span>`;
    expect(roundtrip(src)).toBe(src);
  });

  it("형제 span 두 개(중첩 아님)도 각각 보존", () => {
    const src = `<span color="red">a</span> 그리고 <span underline="true">b</span>`;
    expect(roundtrip(src)).toBe(src);
  });

  it("일반 마크다운 링크 [**bold**](url) 는 span 변환에 영향받지 않는다", () => {
    const src = `[**bold**](https://example.com)`;
    expect(roundtrip(src)).toBe(src);
  });

  // ── F-07: 속성이 둘인 span — Notion 은 빨강+밑줄을 한 태그로 내보낸다. 예전에는 볼트에 그대로 남았다 ──
  it.each([
    [
      `<span color="red" underline="true">**굵게+빨강+밑줄**</span>`,
      `%%im-nobsidian:color:red%%%%im-nobsidian:underline%%**굵게+빨강+밑줄**%%/underline%%%%/color%%`,
      `<span color="red" underline="true">**굵게+빨강+밑줄**</span>`,
    ],
    [
      `<span underline="true" color="blue_bg">둘</span>`,
      `%%im-nobsidian:color:blue_bg%%<u>둘</u>%%/color%%`,
      `<span color="blue_bg" underline="true">둘</span>`,
    ],
  ])("속성이 둘인 span %s — 볼트는 색이 바깥, push 는 한 태그", (src, vault, pushed) => {
    expect(notionEnhancedToObsidian(src)).toBe(vault);
    expect(obsidianToNotionEnhanced(vault)).toBe(pushed);
    expect(notionEnhancedToObsidian(pushed)).toBe(vault);
  });

  // ── 밑줄 표현 — 안이 평문일 때만 <u>. Live Preview 는 <u> 안의 마크다운을 풀지 않는다 ──
  it.each(["밑줄", "50% 할인", "a = b > c", "R&D", " "])("평문 밑줄 %j → <u>", (text) => {
    const src = `<span underline="true">${text}</span>`;
    expect(notionEnhancedToObsidian(src)).toBe(`<u>${text}</u>`);
    expect(roundtrip(src)).toBe(src);
  });

  it.each([
    "**굵게**",
    "_기울임_",
    "~~취소~~",
    "`코드`",
    "[글](https://example.com)",
    "https://example.com",
    "#태그",
    "a\\*b",
    "==형광==",
    "$x$",
    "%%im-nobsidian:color:red%%빨강%%/color%%",
  ])("마크다운이 든 밑줄 %j → 보존 마커", (text) => {
    const src = `<span underline="true">${text}</span>`;
    expect(notionEnhancedToObsidian(src)).toBe(`%%im-nobsidian:underline%%${text}%%/underline%%`);
  });

  it("코드 안의 span 은 글자 그대로 둔다 — HTML 예제 코드", () => {
    const fenced = '```html\n<span color="red">x</span> <span underline="true">u</span>\n```';
    expect(notionEnhancedToObsidian(fenced)).toBe(fenced);
    expect(
      notionEnhancedToObsidian('`<span color="red">x</span>` 와 <span color="red">y</span>'),
    ).toBe('`<span color="red">x</span>` 와 %%im-nobsidian:color:red%%y%%/color%%');
  });

  it("볼트의 <u> 는 밑줄 span 으로 간다 — 안의 인라인 코드도 함께, 코드 안의 <u> 는 글자 그대로", () => {
    expect(obsidianToNotionEnhanced("<u>a `b` c</u>")).toBe(
      '<span underline="true">a `b` c</span>',
    );
    expect(obsidianToNotionEnhanced("`<u>x</u>` 와 <u>y</u>")).toBe(
      '`<u>x</u>` 와 <span underline="true">y</span>',
    );
    const fenced = "```html\n<u>x</u>\n```";
    expect(obsidianToNotionEnhanced(fenced)).toBe(fenced);
  });

  it("Obsidian 마커형은 fixpoint — pull 2회 = pull 1회", () => {
    const src = `<span color="red"><span underline="true">y</span></span>`;
    const once = notionEnhancedToObsidian(src);
    const twice = notionEnhancedToObsidian(once);
    expect(twice).toBe(once);
    // 마커형엔 더 이상 <span> 태그가 없어야 한다(완전 환원).
    expect(once).not.toContain("<span");
  });

  // ── rank20(I3): 멘션 두 경로의 정규형 수렴 ──
  // 같은 Notion 페이지 멘션이 블록 폴백 경로(formatMention)와 markdown-api 경로
  // (notionEnhancedToObsidian 의 <mention-page url=.../>)를 통과해도 **동일한**
  // `[[notion:<32hex>]]` 로 수렴해야 한다. 과거 블록 경로는 `[[<하이픈 id>]]` 를 내보내
  // 두 경로가 갈라졌고, 그 형태는 오케스트레이터 해소 정규식과 맞지 않아 제목 복원에서 누락됐다.
  it("page 멘션 — 블록 경로와 markdown-api 경로가 동일 정규형으로 수렴", () => {
    const hex32 = "12345678123412341234123456789abc";
    const hyphenated = "12345678-1234-1234-1234-123456789abc";
    const fromBlockPath = formatMention({ type: "page", page: { id: hyphenated } }, "제목");
    const fromMarkdownApi = notionEnhancedToObsidian(
      `<mention-page url="https://www.notion.so/${hex32}"/>`,
    );
    expect(fromBlockPath).toBe(`[[notion:${hex32}]]`);
    expect(fromMarkdownApi).toBe(`[[notion:${hex32}]]`);
    expect(fromBlockPath).toBe(fromMarkdownApi); // 수렴 단언
  });
});
