/**
 * I1 라운드트립 deep-equal 충실도 하네스.
 *
 * 프로덕션 파이프라인(createDefaultPipeline)으로 MD→Notion→MD 왕복을 수행하고,
 * frontmatter 는 파싱 후 객체 deep-equal(직렬화 따옴표 차이 무시), body 는 정규화 후
 * 문자열 완전 일치(delta=0)로 비교할 재료를 돌려준다.
 *
 * .toContain 단편 검사가 아니라 "아무것도 손실되지 않았는가"를 증명하기 위한 도구다.
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
  const output = pipeline.convertToMarkdown(push.content, PULL_CTX, {
    properties: push.properties,
  });

  const inParsed = matter(input);
  const outParsed = matter(output);

  return {
    inputData: inParsed.data,
    outputData: outParsed.data,
    inputBody: canonicalBody(inParsed.content),
    outputBody: canonicalBody(outParsed.content),
  };
}
