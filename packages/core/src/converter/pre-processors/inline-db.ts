import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const INLINE_DB_START = /%% obsinotion:inline-db:([^\s]+) %%/g;
const INLINE_DB_END = /%% obsinotion:end %%/g;

export class InlineDBParser implements Processor {
  readonly name = "InlineDBParser";
  readonly order = 40;

  process(input: ProcessorInput): ProcessorOutput {
    const inlineDbBlocks: InlineDBBlock[] = [];
    const content = input.content;

    const startMatches = [...content.matchAll(INLINE_DB_START)];
    for (const match of startMatches) {
      const startIdx = match.index!;
      const params = parseParams(match[1]!);

      const afterStart = content.indexOf("\n", startIdx) + 1;
      const endMatch = INLINE_DB_END.exec(content.slice(afterStart));

      if (endMatch) {
        const tableContent = content.slice(afterStart, afterStart + endMatch.index!);
        inlineDbBlocks.push({
          id: params["id"] ?? "",
          title: params["title"] ?? "",
          tableMarkdown: tableContent.trim(),
          startIdx,
          endIdx: afterStart + endMatch.index! + endMatch[0].length,
        });
      }

      INLINE_DB_END.lastIndex = 0;
    }

    return {
      content,
      metadata: {
        ...input.metadata,
        inlineDbBlocks,
      },
    };
  }
}

interface InlineDBBlock {
  readonly id: string;
  readonly title: string;
  readonly tableMarkdown: string;
  readonly startIdx: number;
  readonly endIdx: number;
}

function parseParams(paramString: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of paramString.split("&")) {
    const [key, value] = pair.split("=");
    if (key && value) {
      params[key] = decodeURIComponent(value);
    }
  }
  return params;
}
