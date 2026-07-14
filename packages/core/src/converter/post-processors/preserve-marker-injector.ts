import type {
  Processor,
  ProcessorInput,
  ProcessorOutput,
  PreserveMarker,
} from "../../types/convert.js";
import { spacedMarker } from "../../constants/markers.js";

/**
 * 다른 복원기가 소비하지 못하고 실제로 유실된 보존 마커를 재삽입하는 최후 보루.
 *
 * 핵심 전제(F28 교훈): DB 에 저장된 startIndex 는 **push 시점 문자열**의 절대
 * 오프셋이라 pull 산출물에서는 무의미하다 — 프론트매터 앞·단어 한가운데에
 * 마커를 박아 파일을 파손시켰다. 재삽입은 반드시
 *   1) 이미 의미적으로 복원된 마커는 건너뛰고(위키링크 → `[[...]]` 존재 등),
 *   2) 텍스트 앵커(__anchor)를 1차 위치 수단으로 쓰며,
 *   3) 프론트매터 뒤·줄 경계에만, 마커 단독 줄로 삽입한다.
 *
 * 이중 모드: `__anchor` 키가 없는 마커는 구버전 DB blob(수집기가 앵커를 안 남기던
 * 시절)이다. 이들은 구계약 — "변환이 마커만 제거했다면 startIndex 오프셋 원문 삽입이
 * 원본을 정확히 재구성한다" — 을 유지하되 프론트매터 앞 삽입만 금지한다. 위해한
 * 레거시 사례(빈 params 껍데기, 이미 복원된 위키링크)는 render-null 폐기와 의미
 * 복원 검사가 이미 걸러낸다.
 */
export class PreserveMarkerInjector implements Processor {
  readonly name = "PreserveMarkerInjector";
  readonly order = 100;

  process(input: ProcessorInput): ProcessorOutput {
    if (input.context.direction !== "pull") {
      return { content: input.content, metadata: input.metadata };
    }

    const markers = input.metadata.preserveMarkers;
    if (!markers || markers.length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    let content = input.content;

    const missing = markers.filter((m) => {
      const rendered = this.renderMarker(m);
      if (rendered === null) return false;
      if (content.includes(rendered)) return false;
      return !this.isSemanticallyRestored(m, content);
    });

    if (missing.length === 0) {
      return { content, metadata: input.metadata };
    }

    const sorted = [...missing].sort((a, b) => a.startIndex - b.startIndex);
    for (const marker of sorted) {
      const rendered = this.renderMarker(marker)!;

      if (marker.params?.__anchor === undefined) {
        // 레거시 마커: startIndex 오프셋에 원문 그대로 삽입(구계약). 프론트매터 앞만 금지.
        const at = Math.max(frontmatterEnd(content), Math.min(marker.startIndex, content.length));
        content = content.slice(0, at) + rendered + content.slice(at);
        continue;
      }

      const at = this.findInsertionPoint(marker, content);
      const before = content.slice(0, at);
      const needsNewline = before.length > 0 && !before.endsWith("\n");
      content = before + (needsNewline ? "\n" : "") + rendered + "\n" + content.slice(at);
    }

    return { content, metadata: input.metadata };
  }

  /** 마커의 본문 표현. 복원 불가능한(빈) 마커는 null — 삽입하지 않고 폐기한다. */
  private renderMarker(marker: PreserveMarker): string | null {
    const params = marker.params ?? {};

    if (marker.type === "comment") {
      return params.text ? `%%${params.text}%%` : null;
    }

    if (params.__raw !== undefined) {
      return spacedMarker(`${marker.type}:${params.__raw}`);
    }

    const entries = Object.entries(params).filter(([key]) => !key.startsWith("__"));
    if (entries.length === 0) return null;
    const body = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    return spacedMarker(`${marker.type}:${body}`);
  }

  /** 마커가 이미 원래 문법으로 복원돼 있으면 재삽입은 중복·오염이다. */
  private isSemanticallyRestored(marker: PreserveMarker, content: string): boolean {
    const params = marker.params ?? {};
    switch (marker.type) {
      case "wikilink": {
        const text = params.text;
        if (!text) return false;
        return content.includes(`[[${text}]]`) || content.includes(`[[${text}|`);
      }
      case "local-image":
      case "local-file": {
        const target = params.__raw ?? params.path;
        return target ? content.includes(`![[${target}]]`) : false;
      }
      case "table-align":
        // 전용 복원기(TableAlignmentRestorer)가 소비/폐기한다 — 본문 재삽입은 노이즈.
        return true;
      default:
        return false;
    }
  }

  /** 삽입 위치: 앵커 → startIndex(줄 경계 보정) 순. 항상 프론트매터 뒤. */
  private findInsertionPoint(marker: PreserveMarker, content: string): number {
    const fmEnd = frontmatterEnd(content);
    const anchor = marker.params?.__anchor;

    if (anchor && anchor.trim().length >= 4) {
      const idx = content.indexOf(anchor, fmEnd);
      if (idx !== -1) {
        return nextLineStart(content, idx + anchor.length);
      }
    }

    const clamped = Math.max(fmEnd, Math.min(marker.startIndex, content.length));
    return nextLineStart(content, clamped);
  }
}

/** 선두 YAML 프론트매터 블록의 끝(다음 본문 시작) 오프셋. 없으면 0. */
function frontmatterEnd(content: string): number {
  if (!content.startsWith("---\n")) return 0;
  const close = content.indexOf("\n---", 3);
  if (close === -1) return 0;
  const lineEnd = content.indexOf("\n", close + 4);
  return lineEnd === -1 ? content.length : lineEnd + 1;
}

/** pos 가 속한 줄의 다음 줄 시작 오프셋(마지막 줄이면 문서 끝). */
function nextLineStart(content: string, pos: number): number {
  const nl = content.indexOf("\n", pos);
  return nl === -1 ? content.length : nl + 1;
}
