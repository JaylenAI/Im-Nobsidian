/**
 * 글로 남는 위키링크(대상이 볼트에 없는 `[[…]]`) — 안의 글자가 Notion 에서 서식이 되지 않고 그대로 돌아온다.
 *
 * Notion 은 `[[…]]` 를 글로 받으면서 `_a_` 를 기울임으로 읽고 `*a*` 로 돌려줘, `[[가 _a_]]` 가 `[[가 *a*]]` 로 돌아와
 * 링크 대상이 바뀌었다(실데이터 재왕복 1 노트). 아래 「받은 꼴」은 escape 해 보낸 본문을 Notion 이 돌려준 그대로다
 * (2026-10-24 실측).
 */
import { describe, it, expect } from "vitest";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { isCompactExport } from "../../src/converter/post-processors/block-spacer.js";

const PUSH = { direction: "push", path: "markdown-api", filePath: "a.md" } as const;
const PULL = { ...PUSH, direction: "pull" } as const;

function send(note: string): string {
  return obsidianToNotionEnhanced(createDefaultPipeline().convertToNotion(note, PUSH).content);
}

function receive(exported: string): string {
  return createDefaultPipeline()
    .convertToMarkdown(notionEnhancedToObsidian(exported), PULL, {
      notionExportCompact: isCompactExport(exported),
    })
    .trimEnd();
}

describe("글로 남는 위키링크 안의 서식 글자", () => {
  it.each([
    ["밑줄 기울임", "[[가 _a_ (1)|별칭 (b)]]", String.raw`[[가 \_a\_ (1)|별칭 (b)]]`],
    ["별 기울임", "앞 [[a *b* c]] 뒤", String.raw`앞 [[a \*b\* c]] 뒤`],
    ["취소선 · 수식", "[[a ~~c~~ $d$]]", String.raw`[[a \~\~c\~\~ \$d\$]]`],
  ])("보낼 때 escape — %s", (_name, note, sent) => {
    expect(send(note)).toContain(sent);
  });

  it.each([
    ["밑줄 기울임", String.raw`\[\[가 _a_ (1)\|별칭 (b)\]\]`, "[[가 _a_ (1)|별칭 (b)]]"],
    ["별 기울임", String.raw`앞 \[\[a \*b\* c\]\] 뒤`, "앞 [[a *b* c]] 뒤"],
    ["취소선", String.raw`\[\[a \~\~b\~\~ c\]\]`, "[[a ~~b~~ c]]"],
    ["코드", String.raw`\[\[a \`b\` c\]\]`, "[[a `b` c]]"],
    ["수식", String.raw`\[\[a \$x\$ b\]\]`, "[[a $x$ b]]"],
    ["꺾쇠", String.raw`\[\[a \<u\>b\</u\> c\]\]`, "[[a <u>b</u> c]]"],
  ])("받을 때 escape 를 푼다 — %s", (_name, exported, note) => {
    expect(receive(exported)).toBe(note);
  });

  it("표 칸 속 별칭 구분자 `\\|` 는 둔다", () => {
    const table = "| a | b |\n| --- | --- |\n| [[x\\|y]] | z |";
    expect(receive(table)).toContain("[[x\\|y]]");
  });

  it("밑줄이 낱말 안에 있는 이름은 그대로 돌아온다", () => {
    expect(send("[[snake_case_name]]")).toContain(String.raw`[[snake\_case\_name]]`);
    expect(receive(String.raw`\[\[snake_case_name\]\]`)).toBe("[[snake_case_name]]");
  });
});
