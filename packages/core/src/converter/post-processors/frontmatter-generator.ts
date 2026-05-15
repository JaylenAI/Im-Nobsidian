import matter from "gray-matter";
import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";

export class FrontmatterGenerator implements Processor {
  readonly name = "FrontmatterGenerator";
  readonly order = 90;

  process(input: ProcessorInput): ProcessorOutput {
    const properties = input.metadata.properties as Record<string, unknown> | undefined;

    if (!properties || Object.keys(properties).length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    const normalized = normalizeProperties(properties);
    const content = matter.stringify(input.content, normalized);

    return {
      content,
      metadata: input.metadata,
    };
  }
}

function normalizeProperties(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    result[key] = normalizeValue(value);
  }

  return result;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeDate(value);
  }

  if (typeof value === "object" && value !== null && "start" in value) {
    const dateObj = value as { start: string; end?: string | null };
    const normalized = {
      start: normalizeDate(dateObj.start),
      ...(dateObj.end ? { end: normalizeDate(dateObj.end) } : {}),
    };
    return normalized;
  }

  return value;
}

function normalizeDate(dateStr: string): string {
  if (typeof dateStr !== "string") return dateStr;
  if (dateStr.match(/T00:00:00\.000[Z+]/)) {
    return dateStr.split("T")[0];
  }
  if (dateStr.match(/T00:00:00[Z+]/)) {
    return dateStr.split("T")[0];
  }
  return dateStr;
}
