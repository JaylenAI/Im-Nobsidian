import type { ConversionPipeline } from "./pipeline.js";
import type { ConversionContext } from "../types/convert.js";
import { obsidianToNotionEnhanced } from "./enhanced-md-converter.js";
import { MATH_FENCE_RE, codeLineMask } from "../utils/md-regions.js";

/**
 * push 가 Notion 에 보낼 꼴 — 경로 · 본문 · 속성 · 미룬 코드 · 올릴 파일을 한 글로. 두 노트의 꼴이 같으면
 * push 한 뒤 Notion 에서 같다(pull 이 로컬 표기를 되살리는 기준, `restoreLocalForm`).
 *
 * 본문은 Markdown API 로 보내는 글에서 코드 · 수식 밖의 빈 줄을 뺀 것이다 — Notion 은 그 빈 줄을 읽지
 * 않는다(2026-10-04 실측: 문단 · 제목 · 인용 · 목록 사이와 콜아웃 · 토글 본문의 빈 줄이 있으나 없으나 같은
 * 블록이다. 인용 속 `>` 만 있는 줄은 빈 줄이 아니라 빈 인용 블록이다). 블록 경로면 블록으로 바꾸기 전의
 * 글 그대로다 — 그 글에서는 빈 줄이 블록을 가른다.
 *
 * 속성은 키 차례를 보지 않는다 — Notion 속성에는 차례가 없다. 페이지 노트의 frontmatter 는 본문의 속성 코드
 * 블록(`PropertiesTableInjector`)에 차례째 실려 본문이 견준다. 보존 마커 목록은 견주지 않는다 — Notion 이
 * 아니라 로컬 상태 DB 에 적고, 자리(`startIndex`)가 노트마다 다르다.
 */
export function sentForm(
  pipeline: ConversionPipeline,
  note: string,
  context: ConversionContext,
): string {
  const path = pipeline.selectPath(note);
  const result = pipeline.convertToNotion(note, {
    direction: "push",
    path,
    filePath: context.filePath,
    parentMode: context.parentMode,
  });
  const body =
    path === "markdown-api"
      ? dropBlankLines(obsidianToNotionEnhanced(result.content))
      : result.content;
  return JSON.stringify([
    path,
    body,
    sortKeys(result.properties),
    result.deferredCode,
    result.images,
  ]);
}

/** NFM 에서 코드 · 수식 밖의 빈 줄(공백 · 탭뿐인 줄)을 뺀다 — 수식 속 빈 줄은 수식의 글이다. */
function dropBlankLines(nfm: string): string {
  const inCode = codeLineMask(nfm);
  let inMath = false;
  return nfm
    .split("\n")
    .filter((line, i) => {
      if (inCode[i]) return true;
      if (MATH_FENCE_RE.test(line)) inMath = !inMath;
      return inMath || line.trim() !== "";
    })
    .join("\n");
}

/** 객체의 키를 차례대로 — 안쪽 객체까지. 날짜 · 배열의 차례는 그대로다. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
}
