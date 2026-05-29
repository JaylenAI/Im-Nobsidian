import matter from "gray-matter";
import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { MARKER_BRAND_RE } from "../../constants/markers.js";

const YAML_PROPERTIES_REGEX = new RegExp(
  "```yaml\\n# " + MARKER_BRAND_RE + ":properties\\n([\\s\\S]*?)```\\n*(?:---\\n*)?",
);

const LEGACY_TABLE_REGEX =
  /^\s*\| Property\s*\| Value\s*\|\n\s*\|\s*-{3,}\s*\|\s*-{3,}\s*\|\n((?:\|[^\n]+\|\n?)+)\n*---\n*/;

export class PropertiesTableRestorer implements Processor {
  readonly name = "PropertiesTableRestorer";
  readonly order = 5;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "pull") {
      return { content: input.content, metadata: input.metadata };
    }

    const yamlMatch = input.content.match(YAML_PROPERTIES_REGEX);
    if (yamlMatch) {
      return this.restoreFromYaml(input, yamlMatch);
    }

    const tableMatch = input.content.match(LEGACY_TABLE_REGEX);
    if (tableMatch) {
      return this.restoreFromTable(input, tableMatch);
    }

    return { content: input.content, metadata: input.metadata };
  }

  private restoreFromYaml(input: ProcessorInput, match: RegExpMatchArray): ProcessorOutput {
    const yamlContent = match[1]!;
    const fakeDocument = `---\n${yamlContent}---\n`;

    let parsed: Record<string, unknown>;
    try {
      const result = matter(fakeDocument);
      parsed = result.data;
    } catch {
      return { content: input.content, metadata: input.metadata };
    }

    const properties: Record<string, unknown> = {
      ...(input.metadata.properties as Record<string, unknown> | undefined),
      ...parsed,
    };

    const content = input.content.replace(YAML_PROPERTIES_REGEX, "").trimStart();

    return {
      content,
      metadata: { ...input.metadata, properties },
    };
  }

  private restoreFromTable(input: ProcessorInput, match: RegExpMatchArray): ProcessorOutput {
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
        properties[key] = parseLegacyValue(rawValue);
      }
    }

    const content = input.content.replace(LEGACY_TABLE_REGEX, "").trimStart();

    return {
      content,
      metadata: { ...input.metadata, properties },
    };
  }
}

function parseLegacyValue(raw: string): unknown {
  if (raw === "" || raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;

  const unquoted = stripQuotes(raw);
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

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
