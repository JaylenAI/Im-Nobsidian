import type {
  Processor,
  ProcessorInput,
  ProcessorOutput,
  PreserveMarker,
} from "../../types/convert.js";

const DELIMITER_CELL_RE = /^:?-{1,}:?$/;

/** 구분행 한 줄을 셀 배열로 파싱한다. 구분행이 아니면 null. */
export function parseDelimiterRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("-") || !trimmed.includes("|")) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = inner.split("|").map((c) => c.trim());
  if (cells.length === 0) return null;
  return cells.every((c) => DELIMITER_CELL_RE.test(c)) ? cells : null;
}

export function cellAlignment(cell: string): "left" | "center" | "right" | "none" {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return "none";
}

export function alignmentsToDelimiter(alignments: string[]): string {
  const cells = alignments.map((a) => {
    switch (a) {
      case "center":
        return ":---:";
      case "right":
        return "---:";
      case "left":
        return ":---";
      default:
        return "---";
    }
  });
  return `| ${cells.join(" | ")} |`;
}

/**
 * GFM 표의 정렬 구분행(`| :--- | :---: | ---: |`)을 Notion markdown 임포터가
 * 구분행으로 인식하지 못해 **데이터 행으로 강등**시킨다(F30, 실측). push 전에
 * 콜론 없는 표준 구분행으로 정규화하고, 정렬 정보는 preserve marker 로 남겨
 * pull 시 TableAlignmentRestorer 가 원형을 복원한다.
 */
export class TableAlignmentGuard implements Processor {
  readonly name = "TableAlignmentGuard";
  readonly order = 45;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "push") {
      return { content: input.content, metadata: input.metadata };
    }

    const markers: PreserveMarker[] = input.metadata.preserveMarkers
      ? [...input.metadata.preserveMarkers]
      : [];

    const lines = input.content.split("\n");
    let changed = false;

    for (let i = 1; i < lines.length; i++) {
      const cells = parseDelimiterRow(lines[i]!);
      if (!cells || !lines[i]!.includes(":")) continue;
      const prev = lines[i - 1]!;
      if (!prev.includes("|")) continue;

      markers.push({
        type: "table-align",
        params: {
          align: cells.map(cellAlignment).join(","),
          __anchor: prev.trim().slice(0, 64),
          // 원본 구분행 원문. 복원 시 정렬뿐 아니라 셀 폭 패딩까지 그대로 되살려
          // 라운드트립 delta-0 을 만족시킨다(__ 접두라 마커 렌더링에서 제외).
          __line: lines[i]!,
        },
        startIndex: 0,
      });
      lines[i] = alignmentsToDelimiter(cells.map(() => "none"));
      changed = true;
    }

    return {
      content: changed ? lines.join("\n") : input.content,
      metadata: { ...input.metadata, preserveMarkers: markers },
    };
  }
}
