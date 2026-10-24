import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { PROPERTIES_TAG } from "../../constants/markers.js";
import { stringifyFrontmatter } from "../../utils/frontmatter.js";
import { isDecorationKey, isDecorationValue } from "../../notion/decoration-values.js";

export class PropertiesTableInjector implements Processor {
  readonly name = "PropertiesTableInjector";
  readonly order = 15;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    if (input.context.parentMode === "database") {
      return { content: input.content, metadata: input.metadata };
    }

    const properties = input.metadata.properties as Record<string, unknown> | undefined;
    if (!properties || Object.keys(properties).length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    // 아이콘 · 커버는 본문이 아니라 페이지의 아이콘 · 커버로 보낸다(`sync/page-decorations.ts`). 그렇게 읽을 수
    // 없는 값(다른 플러그인이 쓰는 `icon` 등)은 예전처럼 속성 블록에 둔다 — 버리면 사라진다.
    const filteredProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (isDecorationKey(key) && isDecorationValue(key, value)) continue;
      filteredProps[key] = value;
    }

    if (Object.keys(filteredProps).length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    const yamlStr = stringifyFrontmatter("", filteredProps).trim();
    const yamlBody = yamlStr.slice(4, -3).trim();
    const codeBlock = "```yaml\n" + PROPERTIES_TAG + "\n" + yamlBody + "\n```";

    const content = codeBlock + "\n\n---\n\n" + input.content;

    return { content, metadata: input.metadata };
  }
}
