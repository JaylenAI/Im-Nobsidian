import { describe, it, expect } from "vitest";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import {
  CLAMPED_INDENT,
  clampCalloutIndent,
  readCalloutIndentDepth,
} from "../../src/converter/callout-indent.js";
import { respace } from "../../src/converter/post-processors/block-spacer.js";
import { calloutIndentMarker } from "../../src/constants/markers.js";

const T = "\t";

// 실측 근거: `Creai LLM.md` 24행 — 리스트 자식으로 들어간 토글이 4칸이 되어 코드블록으로
// 죽어 있었다. NFM 은 리스트 안 토글을 "부모 불릿 + 탭 한 단계 들여쓴 <details>" 로 낸다.
const LIST_TOGGLE_RAW = [
  `- 크리아이 프롬프트 자동생성 Gradio`,
  `${T}<details>`,
  `${T}<summary>1차 디자인</summary>`,
  `${T}${T}본문 한 줄`,
  `${T}</details>`,
].join("\n");

describe("콜아웃 들여쓰기 클램프", () => {
  it("리스트 안 토글이 코드블록 임계(4칸) 아래로 내려온다", () => {
    const pulled = notionEnhancedToObsidian(LIST_TOGGLE_RAW);

    // ① 4칸 콜아웃 = Obsidian 이 들여쓰기 코드블록으로 오파싱하는 형태
    expect(pulled.split("\n").filter((l) => /^(?: {4,}|\t)+>/.test(l))).toHaveLength(0);
    expect(pulled).toContain(`${CLAMPED_INDENT}> [!toggle]- 1차 디자인`);
    // 부모 불릿과의 관계는 유지된다(열 0 으로 떨어뜨리지 않는다)
    expect(pulled).toContain("- 크리아이 프롬프트 자동생성 Gradio");
  });

  it("클램프된 토글이 push 에서 사라지지 않고 <details> 로 복원된다", () => {
    const pushed = obsidianToNotionEnhanced(notionEnhancedToObsidian(LIST_TOGGLE_RAW));

    // 회귀 기준: 열 0 앵커 시절 이 값이 0 이었다(실볼트 <details> 8개 → 0개 소실)
    expect(pushed.split("\n").filter((l) => l.includes("<details>"))).toHaveLength(1);
    expect(pushed).toContain("<summary>1차 디자인</summary>");
    // 구조 들여쓰기는 탭으로 되돌아간다 — NFM 정준형
    expect(pushed).toMatch(/^\t<details>$/m);
    expect(pushed).not.toContain("[!toggle]");
  });

  it("들여쓴 일반 콜아웃도 리터럴로 새지 않고 <callout> 태그가 된다", () => {
    const raw = [`- 부모`, `${T}<callout icon="💡">`, `${T}${T}팁 본문`, `${T}</callout>`].join(
      "\n",
    );
    const pulled = notionEnhancedToObsidian(raw);
    expect(pulled).toContain(`${CLAMPED_INDENT}> [!tip]`);

    const pushed = obsidianToNotionEnhanced(pulled);
    expect(pushed).toMatch(/^\t<callout icon="💡">$/m);
    expect(pushed).toContain("팁 본문");
    expect(pushed).not.toContain("[!tip]");
  });

  it("깊이 2 이상은 마커로 싣고 push 가 탭 두 단계로 되돌린다", () => {
    const pulled = clampCalloutIndent(`${T}${T}> [!toggle]- 깊은 토글\n${T}${T}> 본문`);

    expect(pulled).toContain(calloutIndentMarker(2));
    expect(pulled.startsWith(`${CLAMPED_INDENT}> [!toggle]-`)).toBe(true);

    const pushed = obsidianToNotionEnhanced(pulled);
    expect(pushed).toMatch(/^\t\t<details>$/m);
    expect(pushed).not.toContain("callout-indent");
  });

  it("깊이 1 은 마커 없이 관례로 왕복한다", () => {
    const pulled = clampCalloutIndent(`${T}> [!toggle]- 얕은 토글`);
    expect(pulled).not.toContain("callout-indent");
    expect(readCalloutIndentDepth(CLAMPED_INDENT, "얕은 토글").depth).toBe(1);
    expect(readCalloutIndentDepth("", "열 0").depth).toBe(0);
  });

  it("여백이 다른 이웃 컨테이너를 한 런으로 삼키지 않는다", () => {
    const pulled = clampCalloutIndent(
      [`${T}> [!note] 첫째`, `${T}${T}> [!note] 둘째`, `열 0 문단`].join("\n"),
    );
    const lines = pulled.split("\n");

    expect(lines[0]).toBe(`${CLAMPED_INDENT}> [!note] 첫째`);
    expect(lines[1]).toBe(`${CLAMPED_INDENT}> [!note] 둘째 ${calloutIndentMarker(2)}`);
    expect(lines[2]).toBe("열 0 문단");
  });

  it("펜스 코드블록 안의 들여쓴 인용 리터럴은 건드리지 않는다", () => {
    const raw = ["```md", `${T}> [!note] 예제 코드입니다`, "```"].join("\n");
    expect(clampCalloutIndent(raw)).toBe(raw);
  });

  it("block-spacer 가 인용 줄의 탭을 4칸으로 펼치지 않는다", () => {
    // 결함① 의 실제 생산 지점 — 변환기를 거치지 않은 입력에 대한 안전망
    const respaced = respace(`- 부모\n${T}> [!toggle]- 제목\n${T}> 본문`, true);

    expect(respaced.split("\n").filter((l) => /^ {4,}>/.test(l))).toHaveLength(0);
    expect(respaced).toContain(`${CLAMPED_INDENT}> [!toggle]- 제목`);
  });

  it("리스트 안 형제 토글이 respace 를 거쳐도 융합되지 않는다", () => {
    // 실측 회귀: 클램프된 인용(2칸)이 `INDENTED_CONTINUATION_RE` 에 걸려 리스트 연속으로
    // 흡수되면서 형제 경계 빈 줄이 지워졌다 — 뒤 토글 머리줄이 앞 토글의 본문 텍스트가
    // 되어 `Creai LLM.md` 왕복에서 <details> 8→7 로 줄었다.
    const raw = [
      `- 제타 ai`,
      `${T}<details>`,
      `${T}<summary>A</summary>`,
      `${T}${T}본문 A`,
      `${T}</details>`,
      `${T}<details>`,
      `${T}<summary>B</summary>`,
      `${T}${T}본문 B`,
      `${T}</details>`,
    ].join("\n");

    const pulled = respace(notionEnhancedToObsidian(raw), true);
    const lines = pulled.split("\n");
    const second = lines.findIndex((l) => l.includes("[!toggle]- B"));
    expect(second).toBeGreaterThan(0);
    expect(lines[second - 1]!.trim()).toBe("");

    const pushed = obsidianToNotionEnhanced(pulled);
    expect(pushed.split("\n").filter((l) => l.includes("<summary>"))).toHaveLength(2);
  });

  it("들여쓴 <empty-block/> 토큰이 볼트로 새지 않는다", () => {
    // 결함⑮ — 여백을 인용 접두 **뒤**에서만 받던 앵커링. 리스트/칼럼 안 콜아웃의 빈 줄이
    // 전부 토큰 원문 그대로 노출됐다(`Creai LLM.md` pull 961행).
    const raw = [
      `- 부모`,
      `${T}<details>`,
      `${T}<summary>C</summary>`,
      `${T}${T}첫 줄`,
      `${T}${T}<empty-block/>`,
      `${T}${T}끝 줄`,
      `${T}</details>`,
    ].join("\n");

    expect(notionEnhancedToObsidian(raw)).not.toContain("empty-block");
  });

  it("콜아웃 본문의 상대 들여쓰기가 코드블록으로 오파싱되지 않는다", () => {
    // 실측: 문단의 자식 이미지가 NFM 에서 한 단계 더 들여쓰여 오는데(`\t\t\t![](…)`),
    // dedent 로 공통 폭만 벗기면 상대 탭이 살아 `> \t![](…)` 가 된다. 인용 안 탭 = 4칸 →
    // Obsidian 이 코드로 파싱해 이미지가 회색 상자로 죽었다(`WoRV팀 노션 사용 가이드.md`).
    const raw = [
      `<details>`,
      `<summary>알람 질문</summary>`,
      `${T}알람은 수신 가능함`,
      `${T}${T}![](https://x/a.png)`,
      `</details>`,
    ].join("\n");

    const pulled = notionEnhancedToObsidian(raw);
    expect(pulled.split("\n").filter((l) => /^(?:>[\t ]*)+\t/.test(l))).toHaveLength(0);
    expect(pulled).toContain(`> ${CLAMPED_INDENT}![](https://x/a.png)`);

    // push 는 클램프 폭을 다시 탭으로 되돌린다 — 자식 관계가 Notion 에서 살아남는다
    expect(obsidianToNotionEnhanced(pulled)).toContain(`${T}![](https://x/a.png)`);
  });

  it("중첩 리스트는 클램프 대상이 아니다(상대 들여쓰기 = 중첩 깊이)", () => {
    const raw = [
      `<details>`,
      `<summary>목록</summary>`,
      `${T}- 항목`,
      `${T}${T}- 하위`,
      `</details>`,
    ].join("\n");

    expect(notionEnhancedToObsidian(raw)).toContain(`> ${T}- 하위`);
  });

  it("콜아웃 안 코드펜스가 왕복해도 탭이 쌓이지 않는다", () => {
    const raw = [
      `- 부모`,
      `${T}<details>`,
      `${T}<summary>코드</summary>`,
      `${T}${T}\`\`\`python`,
      `print(1)`,
      `${T}${T}\`\`\``,
      `${T}</details>`,
    ].join("\n");

    const once = obsidianToNotionEnhanced(notionEnhancedToObsidian(raw));
    const twice = obsidianToNotionEnhanced(notionEnhancedToObsidian(once));

    // 래칫 회귀 가드 — 왕복마다 코드 본문에 탭이 한 겹씩 쌓이면 안 된다
    expect(twice).toBe(once);
    expect(once).toContain("print(1)");
  });

  it("콜아웃 안 빈 문단이 인용 깊이를 잃지 않는다", () => {
    // 결함: `removeEmptyBlocks` 가 `> > <empty-block/>` 를 **열 0 빈 줄**로 바꿔 인용
    // 깊이를 통째로 버렸다. Obsidian 은 거기서 인용을 닫으므로 뒤 본문이 콜아웃 밖으로
    // 떨어지고, 중첩 컬럼에선 시작·끝 마커가 서로 다른 본문에 갈려 레이아웃이 소실됐다.
    const raw = [
      `<callout icon="💡">`,
      `${T}바깥`,
      `${T}<callout icon="📌">`,
      `${T}${T}첫 문단`,
      `${T}${T}<empty-block/>`,
      `${T}${T}끝 문단`,
      `${T}</callout>`,
      `</callout>`,
    ].join("\n");

    const pulled = notionEnhancedToObsidian(raw);
    expect(pulled).not.toContain("empty-block");
    // 빈 줄이 얕은 `>` 로 떨어지면 그 자리에서 안쪽 콜아웃이 두 조각 난다
    expect(pulled.split("\n").filter((l) => l.trim() === ">")).toHaveLength(0);
    expect(pulled).toContain("> > [!abstract] 첫 문단");
    expect(pulled).toContain("> >\n> > 끝 문단");
    // 끝 문단이 안쪽 콜아웃 안에 남아야 한다 — 밖으로 새면 push 가 형제로 만든다
    expect(
      obsidianToNotionEnhanced(pulled)
        .split("\n")
        .filter((l) => l.includes("<callout")),
    ).toHaveLength(2);
  });

  it("빈 줄은 이웃 중 얕은 쪽 인용 깊이를 물려받는다", () => {
    // 안쪽 컨테이너가 끝나는 자리의 빈 줄까지 깊은 쪽을 따라가면, 이미 닫힌 컨테이너가
    // 되살아나 다음 블록을 빨아들인다 — 얕은 쪽이 맞다.
    const raw = [
      `<callout icon="💡">`,
      `${T}바깥`,
      `${T}<callout icon="📌">`,
      `${T}${T}안쪽`,
      `${T}</callout>`,
      `${T}<empty-block/>`,
      `${T}바깥 계속`,
      `</callout>`,
    ].join("\n");

    const lines = notionEnhancedToObsidian(raw).split("\n");
    const tail = lines.findIndex((l) => l.includes("바깥 계속"));
    expect(tail).toBeGreaterThan(0);
    expect(lines[tail]).toBe("> 바깥 계속");
    expect(lines[tail - 1]).toBe(">");
  });
});

describe("콜아웃 제목 자리에 구조를 올리지 않는다", () => {
  // 제목 자리로 올린 줄은 본문에서 빠진다. 그 줄이 내용이 아니라 **구조**면 구조가
  // 사라진다 — 중첩 토글의 머리가 제목으로 흡수되면 `> [!tip] > [!toggle]- …` 한 줄로
  // 뭉개져 push 가 `<details>` 를 되살리지 못한다(실측: `<details>` 5개·3노트 소실).
  const NESTED_TOGGLE = [
    `<callout icon="💡">`,
    `${T}<details>`,
    `${T}<summary>중첩 토글</summary>`,
    `${T}${T}안쪽 내용`,
    `${T}</details>`,
    `${T}바깥 계속`,
    `</callout>`,
  ].join("\n");

  it("첫 자식이 중첩 컨테이너면 제목을 비워 둔다", () => {
    const lines = notionEnhancedToObsidian(NESTED_TOGGLE).split("\n");

    expect(lines[0]).toBe("> [!tip]");
    expect(lines[1]).toBe("> > [!toggle]- 중첩 토글");
    expect(lines[2]).toBe("> > 안쪽 내용");
    expect(lines[3]).toBe("> 바깥 계속");
  });

  it("push 가 콜아웃과 중첩 토글을 둘 다 복원한다", () => {
    const pushed = obsidianToNotionEnhanced(notionEnhancedToObsidian(NESTED_TOGGLE));

    expect(pushed).toContain(`<callout icon="💡">`);
    expect(pushed).toContain(`<details>`);
    expect(pushed).toContain(`<summary>중첩 토글</summary>`);
    expect(pushed).toContain(`안쪽 내용`);
    expect(pushed).toContain(`바깥 계속`);
  });
});
