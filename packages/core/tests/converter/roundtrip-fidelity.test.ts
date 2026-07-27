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

    if (PARAGRAPH_SPLIT_BY_DESIGN.has(fixture)) {
      // 문단이 갈리는 것만 봐주고, 글자 손실은 여전히 0 이어야 하며 한 번 갈린 뒤로는 고정.
      expect(squash(r.outputBody), `${fixture}: 글자 손실/추가`).toBe(squash(r.inputBody));
      expect(roundtrip(rebuild(input, r.outputBody)).outputBody, `${fixture}: 왕복 미수렴`).toBe(
        r.outputBody,
      );
      return;
    }

    expect(r.outputBody, `${fixture}: body delta != 0`).toBe(r.inputBody);
  });
});

/**
 * delta=0 을 만족할 수 **없는** 픽스처 — Notion 데이터 모델의 한계다(계층2).
 *
 * `본문 ![[img.png]] 이어서` 처럼 글자 사이에 낀 이미지 임베드는 Notion 에 인라인
 * 이미지가 없어 독립 블록이 될 수밖에 없다. 예전에는 자리표시자를 문장 한가운데
 * 남겨 quote 가 아니게 만들었고, 교체 대상 블록이 없어 이미지가 아예 안 올라갔다(실측).
 * 문단을 가르는 쪽이 옳다 — 대신 여기서 **글자 무손실 + 수렴**을 대신 잠근다.
 */
const PARAGRAPH_SPLIT_BY_DESIGN = new Set(["image-embed-note.md"]);

/** 줄바꿈·공백 차이를 지운 글자 열 — "무엇이 사라졌나"만 본다. */
function squash(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/** 왕복 출력 body 를 원본 frontmatter 에 다시 얹어 2회차 입력을 만든다. */
function rebuild(input: string, body: string): string {
  const fm = /^---\n[\s\S]*?\n---\n/.exec(input)?.[0] ?? "";
  return `${fm}${body}\n`;
}
