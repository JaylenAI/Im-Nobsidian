/**
 * 미디어 링크 표시의 한 정의 — pull 이 붙이는 표시를 push 와 첨부 처리가 같은 목록으로 알아본다.
 */
import { describe, it, expect } from "vitest";
import {
  MEDIA_LABELS,
  MEDIA_LABEL_PREFIX_RE,
  MEDIA_PLACEHOLDER_CAPTIONS,
  mediaLabel,
  mediaLinkRe,
  type MediaLabelKind,
} from "../../src/converter/media-labels.js";

const KINDS = Object.keys(MEDIA_LABELS) as MediaLabelKind[];

describe("media-labels", () => {
  it.each(KINDS)("%s — pull 이 붙인 링크를 push 와 첨부 처리가 알아본다", (kind) => {
    for (const caption of ["", "회의 녹음"]) {
      const link = `[${mediaLabel(kind, caption)}](https://example.com/a)`;
      const match = mediaLinkRe(kind).exec(link);
      expect(match?.[1]).toBe(caption || kind);
      expect(match?.[2]).toBe("https://example.com/a");
      expect(MEDIA_LABEL_PREFIX_RE.test(mediaLabel(kind, caption))).toBe(true);
    }
    expect(MEDIA_PLACEHOLDER_CAPTIONS.has(kind)).toBe(true);
  });

  it("다른 종류의 링크는 고르지 않는다 · 옛 동영상 표시도 첨부로 본다", () => {
    expect(mediaLinkRe("audio").test(`[${mediaLabel("video", "")}](u)`)).toBe(false);
    expect("🎞 옛 동영상".replace(MEDIA_LABEL_PREFIX_RE, "")).toBe("옛 동영상");
    expect(MEDIA_LABEL_PREFIX_RE.test("그냥 링크")).toBe(false);
  });
});
