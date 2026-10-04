import { deferredCodeMarker } from "../../constants/markers.js";
import { richTextChunks } from "../../notion/rich-text.js";
import type {
  DeferredCode,
  Processor,
  ProcessorInput,
  ProcessorOutput,
} from "../../types/convert.js";
import {
  codeLineLead,
  fenceCodeText,
  hasBacktickFenceLine,
  scanCodeFences,
} from "../code-fence.js";
import { notionCodeLanguage } from "../code-language.js";

/**
 * 코드 펜스를 Notion 이 그대로 받는 모양으로 보낸다(S-20) — 언어는 Notion 이름으로, 펜스는 ``` 로.
 *
 * Notion 은 모르는 언어 · 빈 정보 · 속성이 붙은 정보를 javascript 로 저장하고(`dataview` 쿼리가
 * 자바스크립트 블록이 된다), ~~~ 펜스와 네 개 이상의 백틱 펜스는 코드 블록으로 읽지 못한다(2026-09-28
 * 실측). 그래서 언어는 {@link notionCodeLanguage} 로 옮기고 펜스는 ``` 로 바꾼다.
 *
 * 코드에 ``` 로 시작하는 줄이 있으면 Notion 이 어떤 펜스로 보내도 그 줄에서 블록을 가른다 — 백슬래시로
 * 막아도 백슬래시째 저장한다(S-22, 2026-10-04 실측). 그런 코드는 자리표시 한 줄로 보내고 코드는
 * `deferredCode` 로 넘긴다 — 본문을 쓴 뒤 그 자리표시를 가진 코드 블록의 글을 블록 API 로 바꾼다
 * (`sync/deferred-code.ts`). 코드 블록 하나에 담을 수 없을 만큼 긴 코드는 예전처럼 보낸다 — Notion 이
 * 가르더라도 글은 남는다.
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

    const earlier = input.metadata.deferredCode ?? [];
    const deferred = fences
      .filter(hasBacktickFenceLine)
      .map((fence) => ({ fence, code: fenceCodeText(fence) }))
      .filter(({ code }) => richTextChunks(code) !== null);
    const deferredCode: DeferredCode[] = deferred.map(({ code }, i) => ({
      token: deferredCodeMarker(earlier.length + i),
      code,
    }));

    const lines = input.content.split("\n");
    // 뒤에서부터 고친다 — 코드를 자리표시 한 줄로 줄이면 뒤 펜스의 줄 번호가 바뀐다.
    for (const fence of [...fences].reverse()) {
      const k = deferred.findIndex((d) => d.fence === fence);
      // 코드에 ``` 줄이 남는 펜스(너무 긴 코드)는 펜스를 넓힌 채 둔다 — ``` 로 바꾸면 Obsidian 에서도
      // 코드 속 줄이 블록을 닫는다.
      const bar = k === -1 && hasBacktickFenceLine(fence) ? fence.bar : "```";
      const code =
        k === -1
          ? lines.slice(fence.open + 1, fence.close!)
          : [codeLineLead(fence) + deferredCode[k]!.token];
      lines.splice(
        fence.open,
        fence.close! - fence.open + 1,
        fence.lead + bar + notionCodeLanguage(fence.info),
        ...code,
        fence.closeLead! + bar,
      );
    }

    return {
      content: lines.join("\n"),
      metadata:
        deferredCode.length > 0
          ? { ...input.metadata, deferredCode: [...earlier, ...deferredCode] }
          : input.metadata,
    };
  }
}
