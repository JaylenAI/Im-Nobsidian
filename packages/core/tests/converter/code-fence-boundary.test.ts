/**
 * 코드블록 경계 보존 (P11) — 코드 **내용**에 들어 있는 백틱이 블록을 조기에 닫지 못한다.
 *
 * NFM 은 경계 펜스만 탭으로 들여쓰고 코드 내용은 열 0 에 둔다(비대칭 들여쓰기). 경계를
 * 열 0 으로 정렬해야 `> ` 를 붙여도 CommonMark 펜스 규칙을 지키는데, 그 순간 내용 안의
 * 열 0 백틱과 구분이 사라진다. 프롬프트 템플릿·마크다운 튜토리얼처럼 코드 안에 백틱이
 * 든 문서는 흔하고, 경계가 한 칸씩 밀리면 뒤따르는 본문이 통째로 코드로 삼켜진다
 * (실측: 실볼트 한 노트에서 코드블록 5→39개 · 8,200행 삼킴).
 */
import { describe, it, expect } from "vitest";

import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { classifyContainerLines } from "../../src/converter/container-indent.js";
import { codeBoundaryDrift } from "../render/rules.js";

/** 토글 안 코드블록 — NFM 정준형(경계만 탭, 내용은 열 0). */
function toggleWithCode(lines: string[], lang = "markdown"): string {
  return `<details>\n<summary>예시</summary>\n\n\t\`\`\`${lang}\n${lines.join("\n")}\n\t\`\`\`\n\n</details>\n`;
}

/** 인용 접두를 벗기고 옵시디언처럼 순차 짝짓기 — 삼킨 행 수를 센다. */
function swallowed(md: string): number {
  let open: { char: string; len: number } | null = null;
  let n = 0;
  for (const line of md.split("\n")) {
    const body = line.replace(/^((?:\s*>)+)\s?/, "");
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
    if (!open) {
      if (m) open = { char: m[1]![0]!, len: m[1]!.length };
      continue;
    }
    if (m && m[1]![0] === open.char && m[1]!.length >= open.len && m[2]!.trim() === "") open = null;
    else n++;
  }
  return n;
}

describe("코드블록 경계 — 내용 속 백틱", () => {
  it("내용의 ``` 는 블록을 닫지 않는다(분류 기준)", () => {
    const kinds = classifyContainerLines([
      "\t```markdown",
      "예시:",
      "```bash",
      "echo hi",
      "```",
      "끝",
      "\t```",
    ]);
    expect(kinds).toEqual(["fence", "code", "code", "code", "code", "code", "fence"]);
  });

  it("경계 펜스가 내용보다 길게 나가 옵시디언이 짝을 못 틀린다", () => {
    const pulled = notionEnhancedToObsidian(
      toggleWithCode(["예시:", "```bash", "echo hi", "```", "끝"]),
    );
    expect(pulled).toContain("> ````markdown");
    expect(pulled).toContain("> ```bash");
    expect(swallowed(pulled)).toBe(5);
  });

  it("내용에 4틱이 있으면 경계는 5틱으로 물러난다", () => {
    const pulled = notionEnhancedToObsidian(toggleWithCode(["````", "안쪽", "````"]));
    expect(pulled).toContain("> `````markdown");
    expect(swallowed(pulled)).toBe(3);
  });

  it("토글 뒤 본문이 코드로 삼켜지지 않는다", () => {
    const nfm = `${toggleWithCode(["```", "안쪽", "```"])}\n## 다음 장\n\n바깥 본문\n`;
    const pulled = notionEnhancedToObsidian(nfm);
    expect(pulled).toContain("## 다음 장");
    // 삼킨 행은 코드블록 내용 3줄뿐 — 바깥 본문까지 세면 경계가 밀린 것이다.
    expect(swallowed(pulled)).toBe(3);
  });

  it("왕복 — push 가 경계와 내용을 구분한 채 토글을 되살린다", () => {
    const raw = toggleWithCode(["예시:", "```bash", "echo hi", "```"]);
    const pushed = obsidianToNotionEnhanced(notionEnhancedToObsidian(raw));
    expect(pushed).toContain("<details>");
    expect(pushed).toContain("echo hi");
    // 경계는 4틱 한 쌍으로 남고 내용의 ```bash 는 3틱 그대로 — 둘이 섞이면 안 된다.
    expect((pushed.match(/^[\t ]*`{4,}\s*$/gm) ?? []).length).toBe(1);
    expect(pushed).toContain("````markdown");
    expect(pushed).toContain("```bash");
  });

  it("왕복이 수렴한다 — push 한 뒤 다시 pull 해도 볼트 내용이 같다", () => {
    const pulled = notionEnhancedToObsidian(
      toggleWithCode(["예시:", "```bash", "echo hi", "```", "끝"]),
    );
    expect(notionEnhancedToObsidian(obsidianToNotionEnhanced(pulled))).toBe(pulled);
  });

  it("백틱 없는 평범한 코드블록은 3틱 그대로다(불필요한 확장 없음)", () => {
    const pulled = notionEnhancedToObsidian(toggleWithCode(["print(1)"], "python"));
    expect(pulled).toContain("> ```python");
    expect(pulled).not.toContain("````");
  });
});

describe("컨테이너는 통째로 구간에 든다 — 닫는 줄만 밀려나지 않는다", () => {
  // NFM 은 닫는 펜스의 들여쓰기를 흘리기도 한다(여는 줄 `\t\t`, 닫는 줄 열 0). 자식 구간을
  // 한 줄씩 들여쓰기로 판정하면 그 닫는 줄에서 구간이 끊기고, 끝 마커가 코드 **안**
  // (`pnpm build` 와 ``` 사이)에 끼어들어 사용자 코드가 오염된다.
  const nfm = [
    '### 배포 {toggle="true"}',
    "",
    "\t<details>",
    "\t<summary>롤백</summary>",
    "\t\t```bash",
    "git checkout v1.2.3",
    "pnpm build",
    "```",
    "\t</details>",
    "",
    "## 다음 섹션",
    "",
  ].join("\n");

  it("끝 마커가 코드블록 안으로 들어가지 않는다", () => {
    const lines = notionEnhancedToObsidian(nfm).split("\n");
    const marker = lines.findIndex((l) => l.includes("toggle-heading:end"));
    const close = lines.findIndex((l) => /^>?\s*`{3,}\s*$/.test(l) && l.includes("`"));
    expect(marker).toBeGreaterThan(-1);
    expect(marker, "끝 마커는 닫는 펜스 **뒤**에 와야 한다").toBeGreaterThan(close);
    expect(lines.slice(0, marker).join("\n")).toContain("pnpm build");
  });

  it("닫는 펜스가 자식 구간 밖으로 새지 않아 코드 행수가 보존된다", () => {
    expect(codeBoundaryDrift(nfm, notionEnhancedToObsidian(nfm))).toEqual([]);
  });
});

describe("코드 내용 속 마크업은 구조가 아니다", () => {
  it("코드블록 안 <table> 은 표로 치환되지 않는다", () => {
    const raw = toggleWithCode(["<table>", "<tr><td>가</td></tr>", "</table>"], "html");
    const pulled = notionEnhancedToObsidian(raw);
    expect(pulled).toContain("<tr><td>가</td></tr>");
    expect(pulled).not.toContain("| 가 |");
  });

  it("코드블록 **밖** 의 <table> 은 그대로 표가 된다(회귀 방지)", () => {
    const pulled = notionEnhancedToObsidian("<table>\n<tr><td>가</td><td>나</td></tr>\n</table>\n");
    expect(pulled).toContain("| 가 | 나 |");
  });
});
