import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { stripLargeFileLinks } from "../large-file-link.js";

/**
 * 보내기 맨 앞 — 받지 않은 큰 파일 옆에 pull 이 둔 «Notion 에서 열기» 링크를 뗀다. 뒤 전처리가 Notion 페이지 링크로
 * 바꾸기 전이어야 한다(`converter/large-file-link.ts`).
 */
export class LargeFileLinkStripper implements Processor {
  readonly name = "LargeFileLinkStripper";
  readonly order = 0;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }
    return { content: stripLargeFileLinks(input.content), metadata: input.metadata };
  }
}
