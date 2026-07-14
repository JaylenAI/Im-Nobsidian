/**
 * I1 라운드트립 deep-equal 충실도 하네스 — **Obsidian 측 전·후처리 파이프라인** 범위.
 *
 * 프로덕션 파이프라인(createDefaultPipeline)의 pre/post-processor 만으로 MD→(전처리 MD)→
 * (후처리 MD) 왕복을 수행하고, frontmatter 는 파싱 후 객체 deep-equal(직렬화 따옴표 차이
 * 무시), body 는 정규화 후 문자열 완전 일치(delta=0)로 비교할 재료를 돌려준다.
 *
 * .toContain 단편 검사가 아니라 "파이프라인이 아무것도 손실시키지 않는가"를 전체 deep-equal
 * 로 증명한다. 이 하네스가 잠그는 손실 표면은 **martian/notion-to-md 가 건드리지 않는** 부분
 * — frontmatter, preserve-marker(toggle·column·inline-db), 콜아웃, wikilink, 수식 정규화,
 * properties-table, underline/color 주석 — 이다.
 *
 * 범위 밖(이 하네스는 검증하지 않음, 거짓 안전망 방지를 위해 명시):
 *  - martian(MD→Notion 블록) push 변환 → `converter/block-converter.test.ts`(오프라인 유닛)
 *  - notion-to-md(블록→MD) pull 변환 및 실 블록 왕복 fixpoint →
 *    `invariants/block-roundtrip.invariant.test.ts`(라이브 Notion, NOTION_TOKEN 게이트)
 *  - 단일 문서에 전 블록 타입을 한 번에 통과시킨 push 블록 구조 완전성 →
 *    `converter/block-taxonomy-coverage.test.ts`(오프라인, 실 BlockConverter)
 *
 * 즉 이 하네스는 "파이프라인 무손실"을 증명할 뿐 "블록 무손실"을 증명하지 않는다. 블록
 * 무손실은 위 세 테스트가 분담한다(이원 도달성: 오프라인 결정론 + 라이브 Notion).
 */
import matter from "gray-matter";
import {
  createDefaultPipeline,
  type PipelineOptions,
} from "../../src/converter/pipeline-factory.js";
import type { ConversionContext } from "../../src/types/convert.js";

const PUSH_CTX: ConversionContext = {
  direction: "push",
  path: "markdown-api",
  filePath: "test.md",
};
const PULL_CTX: ConversionContext = {
  direction: "pull",
  path: "markdown-api",
  filePath: "test.md",
};

/**
 * 비교용 body 정규화: 줄바꿈 통일, 행말 공백 제거, 3줄 이상 연속 빈줄 축약, 양끝 trim.
 * 의미 없는 공백 차이만 제거하며 실제 콘텐츠는 보존한다.
 */
export function canonicalBody(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * frontmatter 값 canonicalize — js-yaml 은 따옴표 유무에 따라 같은 날짜를 string/Date 로
 * 달리 파싱한다. D3 이후 출력은 따옴표 없는 날짜(=Date 파싱)로 통일되므로, 스타일 차이를
 * 값 비교에서 제거하고 "날짜 값 자체의 보존"만 단언한다. UTC 자정 Date 는 date-only 문자열로.
 */
function canonicalValue(v: unknown): unknown {
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(v)) return v.map(canonicalValue);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canonicalValue(x)]));
  }
  return v;
}

export function canonicalData(data: Record<string, unknown>): Record<string, unknown> {
  return canonicalValue(data) as Record<string, unknown>;
}

export interface RoundtripResult {
  /** 입력 frontmatter(파싱된 객체). */
  readonly inputData: Record<string, unknown>;
  /** 왕복 출력 frontmatter(파싱된 객체). */
  readonly outputData: Record<string, unknown>;
  /** 입력 body(정규화). */
  readonly inputBody: string;
  /** 왕복 출력 body(정규화). */
  readonly outputBody: string;
}

/** input(MD) 을 push→pull 왕복시키고 frontmatter/body 비교 재료를 돌려준다. */
export function roundtrip(input: string, options?: PipelineOptions): RoundtripResult {
  const pipeline = createDefaultPipeline(options);
  const push = pipeline.convertToNotion(input, PUSH_CTX);
  // 프로덕션 배선 재현: push 가 수집한 preserve marker 는 sync.db 에 저장됐다가
  // pull 변환의 초기 metadata 로 주입된다(orchestrator storePreserveMarkers→convertToMarkdown).
  const output = pipeline.convertToMarkdown(push.content, PULL_CTX, {
    properties: push.properties,
    preserveMarkers: push.preserveMarkers.length > 0 ? push.preserveMarkers : undefined,
  });

  const inParsed = matter(input);
  const outParsed = matter(output);

  return {
    inputData: canonicalData(inParsed.data),
    outputData: canonicalData(outParsed.data),
    inputBody: canonicalBody(inParsed.content),
    outputBody: canonicalBody(outParsed.content),
  };
}
