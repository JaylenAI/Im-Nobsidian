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
  it("color 바깥 / underline 안쪽 중첩 — 마커 닫는 순서가 올바르게 중첩된다", () => {
    const src = `<span color="red"><span underline="true">y</span></span>`;
    // 올바른 중첩: color 가 바깥 → 마지막에 닫힘(%%/color%% 가 %%/underline%% 뒤).
    expect(notionEnhancedToObsidian(src)).toBe(
      `%%im-nobsidian:color:red%%%%im-nobsidian:underline%%y%%/underline%%%%/color%%`,
    );
    // 왕복도 당연히 보존(중간형이 올바르면 자명).
    expect(roundtrip(src)).toBe(src);
  });

  it("underline 바깥 / color 안쪽 중첩 — 마커 닫는 순서가 올바르게 중첩된다", () => {
    const src = `<span underline="true"><span color="red">y</span></span>`;
    // 올바른 중첩: underline 이 바깥 → 마지막에 닫힘.
    expect(notionEnhancedToObsidian(src)).toBe(
      `%%im-nobsidian:underline%%%%im-nobsidian:color:red%%y%%/color%%%%/underline%%`,
    );
    expect(roundtrip(src)).toBe(src);
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

  it("Obsidian 마커형은 fixpoint — pull 2회 = pull 1회", () => {
    const src = `<span color="red"><span underline="true">y</span></span>`;
    const once = notionEnhancedToObsidian(src);
    const twice = notionEnhancedToObsidian(once);
    expect(twice).toBe(once);
    // 마커형엔 더 이상 <span> 태그가 없어야 한다(완전 환원).
    expect(once).not.toContain("<span");
  });
});
