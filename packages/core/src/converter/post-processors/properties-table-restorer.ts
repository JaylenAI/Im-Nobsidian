import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

const PROPERTIES_TABLE_REGEX =
  /^\s*\| Property\s*\| Value\s*\|\n\s*\|\s*-{3,}\s*\|\s*-{3,}\s*\|\n((?:\|[^\n]+\|\n?)+)\n*---\n*/;

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

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/;

function parseValue(raw: string): unknown {
  if (raw === "" || raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;

  const unquoted = stripQuotes(raw);

  if (ISO_DATE_REGEX.test(unquoted)) {
    return unquoted.replace(/T00:00:00(?:\.000)?Z?$/, "");
  }

  const num = Number(unquoted);
  if (!isNaN(num) && unquoted.trim() !== "") return num;

  if (unquoted.includes(", ")) {
    const parts = unquoted.split(", ");
    const looksLikeArray = parts.every((p) => p.split(/\s+/).length <= 3);
    if (looksLikeArray) {
      return parts.map((v) => {
        const n = Number(v);
        return !isNaN(n) && v.trim() !== "" ? n : v;
      });
    }
  }

  if (unquoted.startsWith("{") || unquoted.startsWith("[")) {
    try {
      return JSON.parse(unquoted);
    } catch {
      return unquoted;
    }
  }

  return unquoted;
}
