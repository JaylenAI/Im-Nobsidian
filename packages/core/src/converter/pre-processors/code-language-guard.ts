import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { hasBacktickFenceLine, scanCodeFences } from "../code-fence.js";
import { notionCodeLanguage } from "../code-language.js";

/**
 * 코드 펜스를 Notion 이 그대로 받는 모양으로 보낸다(S-20) — 언어는 Notion 이름으로, 펜스는 ``` 로.
 *
 * Notion 은 모르는 언어 · 빈 정보 · 속성이 붙은 정보를 javascript 로 저장하고(`dataview` 쿼리가
 * 자바스크립트 블록이 된다), ~~~ 펜스와 네 개 이상의 백틱 펜스는 코드 블록으로 읽지 못한다(2026-09-28
 * 실측). 그래서 언어는 {@link notionCodeLanguage} 로 옮기고, 코드에 ``` 줄이 없으면 펜스를 ``` 로
 * 바꾼다. 코드에 ``` 줄이 있으면 Notion 이 어떤 펜스로도 그 줄에서 블록을 가르므로 펜스는 둔다.
 *
 * 원래 표기는 기록하지 않는다 — pull 이 로컬 노트의 펜스에서 되살린다(`CodeLanguageRestorer`).
 * 닫히지 않은 펜스는 어디까지가 코드인지 확신할 수 없어 건드리지 않는다.
 */
export class CodeLanguageGuard implements Processor {
  readonly name = "CodeLanguageGuard";
  readonly order = 46;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    const fences = scanCodeFences(input.content).filter((fence) => fence.close !== null);
    if (fences.length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    const lines = input.content.split("\n");
    for (const fence of fences) {
      const bar = hasBacktickFenceLine(fence) ? fence.bar : "```";
      lines[fence.open] = fence.lead + bar + notionCodeLanguage(fence.info);
      lines[fence.close!] = fence.closeLead! + bar;
    }

    return { content: lines.join("\n"), metadata: input.metadata };
  }
}
