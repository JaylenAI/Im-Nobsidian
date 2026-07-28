import { describe, it, expect } from "vitest";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";
import { classifyContainerLines, nfmOpenTagSource } from "../../src/converter/container-indent.js";

/**
 * NFM 태그명 경계 회귀.
 *
 * NFM 은 접두가 겹치는 이름을 쓴다 — `table`/`table_of_contents`,
 * `synced_block`/`synced_block_reference`, `column`/`columns`. 여는 태그를
 * `<table[^>]*>` 처럼 이름 뒤를 열어 두고 잡으면 짧은 이름이 긴 이름을 삼킨다.
 * 실측: 목차 태그가 여는 표로 잡혀 거기서 저 아래 첫 `</table>` 까지가 표로 치환되며
 * 한 노트에서 본문 128행이 통째로 사라졌다.
 */
describe("NFM 여는 태그 이름 경계", () => {
  it("<table_of_contents/> 는 표를 열지 않는다 — 사이 본문이 살아남는다", () => {
    const raw = [
      `<table_of_contents color="gray"/>`,
      ``,
      `## 원칙 1`,
      ``,
      `본문 A`,
      ``,
      `<table>`,
      `<tr><td>헤더</td></tr>`,
      `<tr><td>값</td></tr>`,
      `</table>`,
      ``,
      `꼬리 문단`,
    ].join("\n");

    const pulled = notionEnhancedToObsidian(raw);

    // 목차 태그와 진짜 `</table>` 사이의 본문이 통째로 삼켜지던 자리
    expect(pulled).toContain("## 원칙 1");
    expect(pulled).toContain("본문 A");
    expect(pulled).toContain("꼬리 문단");
    // 진짜 표는 여전히 마크다운 표로 변환된다
    expect(pulled).toContain("| 헤더 |");
    expect(pulled).toContain("| 값 |");
  });

  it("classifyContainerLines 가 목차 줄을 표 경계로 오인하지 않는다", () => {
    const kinds = classifyContainerLines([
      `<table_of_contents color="gray"/>`,
      `본문`,
      `<table>`,
      `<tr><td>값</td></tr>`,
      `</table>`,
    ]);

    // 목차를 표 시작으로 보면 이후 전부가 "표 내부(code)"가 되어 dedent 가 멈춘다
    expect(kinds[0]).toBe("prose");
    expect(kinds[1]).toBe("prose");
    expect(kinds[2]).toBe("fence");
    expect(kinds[3]).toBe("code");
    expect(kinds[4]).toBe("fence");
  });

  it("synced_block_reference 가 synced_block 으로 잡히지 않는다 — 종류가 뒤바뀌지 않는다", () => {
    const raw = [
      `<synced_block_reference url="https://www.notion.so/ref1">`,
      `참조 내용`,
      `</synced_block_reference>`,
      ``,
      `<synced_block url="https://www.notion.so/orig1">`,
      `원본 내용`,
      `</synced_block>`,
    ].join("\n");

    const pulled = notionEnhancedToObsidian(raw);

    expect(pulled).toContain("kind=ref&url=https%3A%2F%2Fwww.notion.so%2Fref1");
    expect(pulled).toContain("kind=orig&url=https%3A%2F%2Fwww.notion.so%2Forig1");
    expect(pulled).toContain("참조 내용");
    expect(pulled).toContain("원본 내용");
  });

  it("nfmOpenTagSource 가 이름이 끝나는 것을 확인한다", () => {
    const table = new RegExp(nfmOpenTagSource("table"));

    expect(table.test(`<table>`)).toBe(true);
    expect(table.test(`<table color="red">`)).toBe(true);
    expect(table.test(`<table_of_contents color="gray"/>`)).toBe(false);
    // 속성 캡처형은 선행 공백을 포함한 원문을 남긴다(속성 없으면 빈 문자열)
    expect(
      new RegExp(nfmOpenTagSource("callout", "capture")).exec(`<callout icon="💡">`)?.[1],
    ).toBe(` icon="💡"`);
    expect(new RegExp(nfmOpenTagSource("callout", "capture")).exec(`<callout>`)?.[1]).toBe("");
  });
});
