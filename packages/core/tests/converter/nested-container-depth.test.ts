/**
 * 칸으로 들인 목록 아래 깊이 2 이상 콜아웃 · 토글 — Notion 이 한 단계 얕게 받던 결함.
 *
 * 실측(2026-10-23): `    - [ ] 할` 아래 `\t\t<callout>` 는 항목의 형제가 되고, `        <callout>` 는 자식이 된다.
 * 받은 볼트의 목록은 칸으로 들여 있으므로 깊이 마커로 되살린 컨테이너도 칸으로 들인다.
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

const pull = (nfm: string): string =>
  createDefaultPipeline().convertToMarkdown(notionEnhancedToObsidian(nfm), PULL, {
    notionExportCompact: isCompactExport(nfm),
  });
const push = (note: string): string =>
  obsidianToNotionEnhanced(createDefaultPipeline().convertToNotion(note, PUSH).content);

/** 보낸 글에서 여는 컨테이너 줄의 들여쓰기만 뽑는다. */
const opens = (sent: string): string[] =>
  sent
    .split("\n")
    .filter((l) => /^[\t ]*<(callout|details)/.test(l))
    .map((l) => /^[\t ]*/.exec(l)![0]);

describe("깊이 마커로 되살린 컨테이너의 들여쓰기 단위", () => {
  it("칸으로 들인 목록 항목의 자식 콜아웃은 칸으로 들인다", () => {
    const vault = pull(
      '1. 가\n\t- [ ] 할\n\t\t<callout icon="💡">\n\t\t\t둘\n\t\t</callout>\n\t- [ ] 끝\n',
    );
    expect(vault).toContain("callout-indent:2");
    expect(opens(push(vault))).toEqual(["        "]);
  });

  it("칼럼 안에서도 같다 — 칼럼 접두 탭 뒤에 칸", () => {
    const vault = pull(
      '<columns>\n\t<column>\n\t\t왼\n\t</column>\n\t<column>\n\t\t1. 가\n\t\t\t- [ ] 할\n\t\t\t\t<callout icon="💡">\n\t\t\t\t\t둘\n\t\t\t\t</callout>\n\t</column>\n</columns>\n',
    );
    expect(opens(push(vault))).toEqual(["\t\t        "]);
  });

  it("토글도 같다", () => {
    const vault = pull(
      "1. 가\n\t- [ ] 할\n\t\t<details>\n\t\t<summary>토</summary>\n\t\t\t속\n\t\t</details>\n",
    );
    expect(opens(push(vault))).toEqual(["        "]);
  });

  it("목록 속 토글 안 콜아웃은 토글 본문 깊이를 지킨다 — 예전에는 토글 들여쓰기를 제 깊이로 읽었다", () => {
    const toggleIn = (prefix: string) =>
      `${prefix}<details>\n${prefix}<summary>토</summary>\n${prefix}\t속\n${prefix}\t\t<callout icon="💡">\n${prefix}\t\t\t안\n${prefix}\t\t</callout>\n${prefix}</details>`;
    const sentNested = push(pull(`1. 가\n\t- [ ] 할\n${toggleIn("\t\t")}\n\t- [ ] 끝\n`));
    expect(opens(sentNested)).toEqual(["        ", "        \t"]);
    const sentShallow = push(pull(`1. 가\n${toggleIn("\t")}\n`));
    expect(opens(sentShallow)).toEqual(["\t", "\t\t"]);
  });

  it("깊이 1 과 탭으로 들인 목록 아래는 예전처럼 탭이다", () => {
    expect(opens(push("1. 가\n  > [!tip] 하나\n"))).toEqual(["\t"]);
    expect(
      opens(push("- 가\n\t- 할\n\n  > [!tip] 둘 %%im-nobsidian:callout-indent:2%%\n")),
    ).toEqual(["\t\t"]);
  });

  it("다시 받으면 같은 볼트다", () => {
    const vault = pull(
      '1. 가\n\t- [ ] 할\n\t\t<callout icon="💡">\n\t\t\t둘\n\t\t</callout>\n\t- [ ] 끝\n',
    );
    // Notion 은 칸 4개를 탭 하나로 돌려준다(실측). 끝 줄바꿈은 받기가 따로 붙인다.
    const exported = push(vault)
      .replace(/^( {4})+/gm, (m) => "\t".repeat(m.length / 4))
      .replace(/\n{2,}/g, "\n");
    expect(pull(exported).trimEnd()).toBe(vault.trimEnd());
  });
});
