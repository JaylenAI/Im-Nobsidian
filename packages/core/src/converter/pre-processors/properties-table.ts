import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

export class PropertiesTableInjector implements Processor {
  readonly name = "PropertiesTableInjector";
  readonly order = 15;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    const properties = input.metadata.properties as Record<string, unknown> | undefined;
    if (!properties || Object.keys(properties).length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    const filteredEntries = Object.entries(properties).filter(([key]) => key !== "title");
    if (filteredEntries.length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    const rows = filteredEntries.map(([key, value]) => {
      const display = formatValue(value);
      return `| ${key} | ${display} |`;
    });

    const table = ["| Property | Value |", "| --- | --- |", ...rows].join("\n");

    const content = table + "\n\n---\n\n" + input.content;

    return { content, metadata: input.metadata };
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
