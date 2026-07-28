import { describe, it, expect } from "vitest";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { splitContainerPrefix } from "../../src/converter/container-indent.js";

const T = "\t";

/**
 * 실측 형태(`240122 _ Conformer STT 활용 교육.md` 17행): NFM 은 `<table>` 태그만 구조
 * 들여쓰기를 주고 `<tr>/<td>` 는 열 0 에 둔다.
 */
const TABLE_IN_TOGGLE = [
  `<details>`,
  `<summary>성능 비교</summary>`,
  `${T}<table>`,
  `<tr>`,
  `<td>모델</td>`,
  `<td>CER</td>`,
  `</tr>`,
  `<tr>`,
  `<td>Whisper</td>`,
  `<td>12.06%</td>`,
  `</tr>`,
  `</table>`,
  `</details>`,
].join("\n");

describe("컨테이너 안 표", () => {
  it("모든 행이 콜아웃 인용 접두를 유지한다", () => {
    const pulled = notionEnhancedToObsidian(TABLE_IN_TOGGLE);
    const rows = pulled.split("\n").filter((l) => l.includes("|"));

    expect(rows).toHaveLength(3); // 헤더 + 구분행 + 데이터 1행
    for (const row of rows) expect(row.startsWith("> ")).toBe(true);
  });

  it("구분행이 헤더와 같은 블록에 남는다(표 사망 방지)", () => {
    const lines = notionEnhancedToObsidian(TABLE_IN_TOGGLE).split("\n");
    const sep = lines.findIndex((l) => /\|\s*---/.test(l));

    expect(sep).toBeGreaterThan(0);
    // 결함⑧: 구분행 앞줄이 같은 접두의 표 행이 아니면 Obsidian 이 표로 렌더하지 않는다
    const prev = lines[sep - 1]!;
    expect(splitContainerPrefix(prev).prefix).toBe(splitContainerPrefix(lines[sep]!).prefix);
    expect(splitContainerPrefix(prev).body.startsWith("|")).toBe(true);
  });

  it("표가 살아 있는 채로 push 왕복하고 수렴한다", () => {
    const pulled = notionEnhancedToObsidian(TABLE_IN_TOGGLE);
    const pushed = obsidianToNotionEnhanced(pulled);
    const lines = pushed.split("\n");

    // 표는 <details> 본문 **안**에 있어야 한다 — 밖으로 새면 토글이 조각난다.
    // 본문 내부가 열 0 인 것은 NFM 의 비대칭 들여쓰기 관례 그대로다(container-indent).
    const open = lines.indexOf("<details>");
    const close = lines.indexOf("</details>");
    const rows = lines.reduce<number[]>((acc, l, i) => (l.startsWith("|") ? [...acc, i] : acc), []);
    expect(rows).toHaveLength(3);
    for (const i of rows) expect(i > open && i < close).toBe(true);
    expect(pushed).toContain("12.06%");

    // 두 번째 왕복이 첫 번째와 같아야 한다(래칫 없음)
    expect(obsidianToNotionEnhanced(notionEnhancedToObsidian(pushed))).toBe(pushed);
  });

  it("셀 안 파이프·줄바꿈이 표를 깨뜨리지 않는다", () => {
    const raw = [
      `<table>`,
      `<tr>`,
      `<td>모델 \\ 데이터셋</td>`,
      `<td>a | b</td>`,
      `</tr>`,
      `<tr>`,
      `<td>첫 줄\n둘째 줄</td>`,
      `<td>x</td>`,
      `</tr>`,
      `</table>`,
    ].join("\n");
    const pulled = notionEnhancedToObsidian(raw);
    const rows = pulled.split("\n").filter((l) => l.trim().startsWith("|"));

    expect(rows).toHaveLength(3);
    // 모든 행의 열 개수가 같아야 표로 렌더된다 — 셀 파이프가 새면 여기서 깨진다
    const cols = rows.map((r) => r.split(/(?<!\\)\|/).length);
    expect(new Set(cols).size).toBe(1);
    expect(pulled).toContain("a \\| b");
    expect(pulled).toContain("첫 줄<br>둘째 줄");
  });

  it("속성이 붙은 행(`<tr color>`)도 한 행으로 살아남는다", () => {
    // 실측(`5단계(22~28일) …`): Notion 은 배경색을 지정한 행을 `<tr color="gray_bg">` 로
    // 내보내고, 그 행은 대개 **헤더**다. `<tr>` 만 잡으면 헤더가 통째로 사라지고 다음
    // 데이터 행이 헤더 자리로 승격돼 표의 의미가 바뀐다 — 그런데도 표는 멀쩡해 보인다.
    const raw = [
      `<table header-row="true">`,
      `<colgroup>`,
      `<col width="120"/>`,
      `<col width="240"/>`,
      `</colgroup>`,
      `<tr color="gray_bg">`,
      `<td>결과</td>`,
      `<td>해결책</td>`,
      `</tr>`,
      `<tr>`,
      `<td>근육 감소</td>`,
      `<td>단백질 증량</td>`,
      `</tr>`,
      `</table>`,
    ].join("\n");
    const pulled = notionEnhancedToObsidian(raw);
    const rows = pulled.split("\n").filter((l) => l.trim().startsWith("|"));

    expect(rows).toHaveLength(3); // 헤더 + 구분행 + 데이터 1행
    expect(rows[0]).toContain("결과");
    expect(rows[0]).toContain("해결책");
    expect(obsidianToNotionEnhanced(pulled)).toContain("결과");
  });

  it("인용 안 표의 셀 이스케이프가 unescapePipes 로 풀리지 않는다", () => {
    const raw = [
      `<callout icon="💡">`,
      `${T}비교표`,
      `${T}<table>`,
      `<tr>`,
      `<td>a | b</td>`,
      `<td>c</td>`,
      `</tr>`,
      `</table>`,
      `</callout>`,
    ].join("\n");

    // 결함: unescapePipes 가 열 0 기준으로만 표를 인식해 `> | a \| b |` 의 이스케이프를 풀었다
    expect(notionEnhancedToObsidian(raw)).toContain("a \\| b");
  });
});
