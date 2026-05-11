import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const PROPERTIES_TABLE_REGEX =
  /^\| Property \| Value \|\n\| --- \| --- \|\n((?:\|[^\n]+\|\n?)+)\n*---\n*/;

export class PropertiesTableRestorer implements Processor {
  readonly name = "PropertiesTableRestorer";
  readonly order = 5;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "pull") {
      return { content: input.content, metadata: input.metadata };
    }

    const match = input.content.match(PROPERTIES_TABLE_REGEX);
    if (!match) {
      return { content: input.content, metadata: input.metadata };
    }

    const rows = match[1]!.trim().split("\n");
    const properties: Record<string, unknown> = {
      ...(input.metadata.properties as Record<string, unknown> | undefined),
    };

    for (const row of rows) {
      const cells = row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length >= 2) {
        const key = cells[0]!;
        const rawValue = cells[1]!;
        properties[key] = parseValue(rawValue);
      }
    }

    const content = input.content.replace(PROPERTIES_TABLE_REGEX, "").trimStart();

    return {
      content,
      metadata: { ...input.metadata, properties },
    };
  }
}

function parseValue(raw: string): unknown {
  if (raw === "" || raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;

  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== "") return num;

  if (raw.includes(", ")) {
    return raw.split(", ").map((v) => {
      const n = Number(v);
      return !isNaN(n) && v.trim() !== "" ? n : v;
    });
  }

  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}
