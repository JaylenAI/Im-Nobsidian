import type {
  Processor,
  ProcessorInput,
  ProcessorOutput,
  PreserveMarker,
} from "../../types/convert.js";
import {
  parseDelimiterRow,
  cellAlignment,
  alignmentsToDelimiter,
} from "../pre-processors/table-alignment.js";

/**
 * 표 정렬 왕복 복원(F30)의 pull 쪽 절반.
 *
 * 1) 팬텀 행 치유 — TableAlignmentGuard 이전에 push 된 페이지는 Notion 표에
 *    정렬행이 데이터 행으로 박혀 있다. 표준 구분행 바로 아래에 콜론 정렬
 *    패턴 행이 오면 구분행에 병합하고 데이터 행을 제거한다.
 * 2) 마커 복원 — Guard 가 남긴 table-align 마커의 앵커(헤더 행)를 찾아
 *    표준 구분행을 원래 정렬 구분행으로 되돌린다. 소비한 마커는 metadata 에서
 *    제거해 PreserveMarkerInjector 의 재삽입 대상에서 뺀다.
 */
export class TableAlignmentRestorer implements Processor {
  readonly name = "TableAlignmentRestorer";
  readonly order = 35;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "pull") {
      return { content: input.content, metadata: input.metadata };
    }

    const lines = input.content.split("\n");

    // 1) 팬텀 정렬행 치유
    for (let i = 1; i < lines.length - 1; i++) {
      const delim = parseDelimiterRow(lines[i]!);
      if (!delim || lines[i]!.includes(":")) continue;
      const phantom = parseDelimiterRow(lines[i + 1]!);
      if (!phantom || !lines[i + 1]!.includes(":") || phantom.length !== delim.length) continue;
      if (!lines[i - 1]!.includes("|")) continue;
      lines[i] = alignmentsToDelimiter(phantom.map(cellAlignment));
      lines.splice(i + 1, 1);
    }

    // 2) table-align 마커 복원 (+소비)
    const markers = input.metadata.preserveMarkers ?? [];
    const remaining: PreserveMarker[] = [];
    for (const marker of markers) {
      if (marker.type !== "table-align" || !marker.params.align || !marker.params.__anchor) {
        remaining.push(marker);
        continue;
      }
      const anchor = marker.params.__anchor;
      const idx = lines.findIndex(
        (line, i) =>
          i < lines.length - 1 &&
          line.trim().startsWith(anchor) &&
          parseDelimiterRow(lines[i + 1]!) !== null,
      );
      if (idx === -1) continue; // 앵커 유실 — 정렬만 소실시키고 마커는 폐기(재삽입 노이즈 방지)
      const delimCells = parseDelimiterRow(lines[idx + 1]!)!;
      if (lines[idx + 1]!.includes(":")) continue; // 이미 정렬 구분행(팬텀 치유 경로가 처리)
      // 원본 구분행 원문(__line)이 있고 셀 수가 일치하면 그대로 복원(폭 패딩까지 delta-0).
      // 없거나 표 구조가 달라졌으면 정렬 정보만으로 표준형을 합성한다.
      const originalLine = marker.params.__line;
      if (originalLine && parseDelimiterRow(originalLine)?.length === delimCells.length) {
        lines[idx + 1] = originalLine;
        continue;
      }
      const alignments = marker.params.align.split(",");
      while (alignments.length < delimCells.length) alignments.push("none");
      lines[idx + 1] = alignmentsToDelimiter(alignments.slice(0, delimCells.length));
    }

    return {
      content: lines.join("\n"),
      metadata: { ...input.metadata, preserveMarkers: remaining },
    };
  }
}
