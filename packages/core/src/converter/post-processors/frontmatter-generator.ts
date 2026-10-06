import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { mergeRowFrontmatter } from "../frontmatter-merge.js";
import { restoreLinkMarkersInValue } from "../link-restore.js";
import { joinFrontmatter, stringifyFrontmatter } from "../../utils/frontmatter.js";

export class FrontmatterGenerator implements Processor {
  readonly name = "FrontmatterGenerator";
  readonly order = 90;

  process(input: ProcessorInput): ProcessorOutput {
    const properties = input.metadata.properties as Record<string, unknown> | undefined;

    if (!properties || Object.keys(properties).length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    // Pull 시 속성 값에 박힌 위키링크/임베드 보존 마커를 [[...]] 로 복원한다.
    const pull = input.context.direction === "pull";
    const normalized = normalizeProperties(properties, pull);

    // 행은 받은 속성을 로컬 frontmatter 에 합친다 — 로컬에만 있는 키 · 키 차례 · 적은 모양을 지킨다(F-08).
    const { localContent, notionKeys } = input.metadata;
    const merged =
      pull && localContent !== undefined && notionKeys
        ? mergeRowFrontmatter(localContent, normalized, new Set(notionKeys))
        : null;
    const content = merged
      ? joinFrontmatter(merged, input.content)
      : stringifyFrontmatter(input.content, normalized);

    return {
      content,
      metadata: input.metadata,
    };
  }
}

function normalizeProperties(
  props: Record<string, unknown>,
  restoreMarkers: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    const restored = restoreMarkers ? restoreLinkMarkersInValue(value) : value;
    const normalized = normalizeValue(restored);
    if (normalized !== undefined) {
      result[key] = normalized;
    }
  }

  return result;
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return normalizeDate(value.toISOString());
  }

  if (typeof value === "string") {
    return normalizeDate(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return value;
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

const MIDNIGHT_RE = /T00:00:00(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})/;

function normalizeDate(dateStr: string): string {
  if (typeof dateStr !== "string") return dateStr;
  if (MIDNIGHT_RE.test(dateStr)) {
    return dateStr.split("T")[0] ?? dateStr;
  }
  return dateStr;
}
