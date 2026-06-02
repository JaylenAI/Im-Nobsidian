/**
 * I1 — MD 라운드트립 deep-equal 충실도.
 *
 * fixtures/obsidian 의 모든 노트를 push→pull 왕복시켜:
 *  - frontmatter: 파싱 객체 deep-equal (toEqual) — 직렬화 따옴표 스타일 차이는 무시,
 *    값 자체가 변형되면(예: 위키링크 마커 미복원) 실패.
 *  - body: 정규화 후 완전 일치 (toBe, delta=0) — 어떤 라인도 손실/추가되면 실패.
 *
 * .toContain 단편 검사를 쓰지 않는다(거짓종료방지). 손실이 있으면 vitest diff 로 노출된다.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { roundtrip } from "./roundtrip-fidelity.js";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/obsidian");

const FIXTURES = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".md"))
  .sort();

describe("I1 라운드트립 deep-equal 충실도 (fixtures/obsidian 전체)", () => {
  it("픽스처 코퍼스가 20개 이상 존재한다", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);
  });

  it.each(FIXTURES)("%s: push→pull 후 frontmatter+body delta=0", (fixture) => {
    const input = readFileSync(join(FIXTURES_DIR, fixture), "utf-8");
    const r = roundtrip(input);

    expect(r.outputData, `${fixture}: frontmatter 값 손실/변형`).toEqual(r.inputData);
    expect(r.outputBody, `${fixture}: body delta != 0`).toBe(r.inputBody);
  });
});
