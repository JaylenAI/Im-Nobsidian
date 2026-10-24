/**
 * 목록 속 첨부 자리표시자 — 받으면 원래 들여쓰기로 돌아온다.
 *
 * 올리지 못한 첨부(무료 플랜 5MB 한도 등)는 `> 📎 … %% …:local-image:… %%` 자리표시자로 올라간다. 목록 자식이면
 * Notion 은 탭 한 단계로 내보내고, 받기는 들여쓴 인용을 2칸으로 눌러 둔다(Obsidian 이 4칸 인용을 코드로 그린다).
 * 임베드로 되돌린 뒤에도 2칸이 남아 `    ![[a.png]]` 가 `  ![[a.png]]` 로 바뀌었다(실데이터 E2E 42 노트).
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

/** push 가 보낸 글을 Notion 이 압축형으로 돌려준 것처럼 받는다. 끝 줄바꿈은 받기가 따로 붙인다 — 보지 않는다. */
function roundTrip(note: string): string {
  const pipeline = createDefaultPipeline();
  const sent = obsidianToNotionEnhanced(pipeline.convertToNotion(note, PUSH).content);
  const exported = sent.replace(/\n{2,}/g, "\n").replace(/ {4}/g, "\t");
  return pipeline
    .convertToMarkdown(notionEnhancedToObsidian(exported), PULL, {
      notionExportCompact: isCompactExport(exported),
    })
    .trimEnd();
}

describe("목록 속 첨부 자리표시자의 들여쓰기", () => {
  it.each([
    ["목록 자식 둘", "앞\n\n- 항목\n    ![[att/a.png]]\n    ![[att/b.pdf]]\n\n뒤\n"],
    ["번호 목록 자식", "1. 항목\n    ![[att/a.png]]\n"],
    ["맨 바깥", "앞\n\n![[att/a.png]]\n\n뒤\n"],
  ])("올리지 못한 첨부가 받은 볼트에서 원래 자리로 — %s", (_name, note) => {
    expect(roundTrip(note)).toBe(note.trimEnd());
  });

  it("문단 자식은 2칸 그대로다 — 간격 정리의 문단 자식 규칙", () => {
    const note = "문단\n  ![[att/a.png]]\n";
    expect(roundTrip(note)).toBe(roundTrip(roundTrip(note)));
  });
});
