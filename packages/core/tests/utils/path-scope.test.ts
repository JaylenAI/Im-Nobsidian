import { describe, it, expect } from "vitest";
import { matchesPathScope, inAnyPathScope } from "../../src/utils/path-scope.js";

/**
 * R4 D-PULLSCOPE 회귀 잠금 — `--path` 는 **경로 조각 경계**에서만 걸려야 한다.
 *
 * 예전 구현은 그냥 `startsWith` 였다. `--path Notes` 하나가 `Notes-archive/`, `Notes백업.md`
 * 처럼 이름만 겹치는 이웃까지 끌어와 pull/push 대상에 올렸다 — 사용자가 범위를 좁힌 바로
 * 그 의도를 조용히 뒤집는 종류의 결함이라, 경계 케이스를 여기서 못 박는다.
 */
describe("matchesPathScope", () => {
  it("범위와 정확히 같은 경로는 걸린다", () => {
    expect(matchesPathScope("Notes", "Notes")).toBe(true);
    expect(matchesPathScope("Notes/a.md", "Notes/a.md")).toBe(true);
  });

  it("범위 폴더 아래 경로는 걸린다", () => {
    expect(matchesPathScope("Notes/a.md", "Notes")).toBe(true);
    expect(matchesPathScope("Notes/sub/deep/a.md", "Notes")).toBe(true);
  });

  it("이름만 겹치는 이웃은 걸리지 않는다 (D-PULLSCOPE)", () => {
    expect(matchesPathScope("Notes-archive/secret.md", "Notes")).toBe(false);
    expect(matchesPathScope("Notes백업.md", "Notes")).toBe(false);
    expect(matchesPathScope("Notes.md", "Notes")).toBe(false);
    expect(matchesPathScope("NotesOld/a.md", "Notes")).toBe(false);
  });

  it("범위 끝의 슬래시는 있어도 없어도 같게 판정한다", () => {
    expect(matchesPathScope("Notes/a.md", "Notes/")).toBe(true);
    expect(matchesPathScope("Notes-archive/a.md", "Notes/")).toBe(false);
    // 슬래시를 떼면 범위 자기 자신도 같은 판정을 받아야 한다.
    expect(matchesPathScope("Notes", "Notes/")).toBe(true);
  });

  it("빈 범위(볼트 루트)는 모두 걸린다", () => {
    expect(matchesPathScope("a.md", "")).toBe(true);
    expect(matchesPathScope("any/deep/path.md", "/")).toBe(true);
  });

  it("중첩 범위도 조각 경계를 지킨다", () => {
    expect(matchesPathScope("A/B/c.md", "A/B")).toBe(true);
    expect(matchesPathScope("A/BB/c.md", "A/B")).toBe(false);
  });
});

describe("inAnyPathScope", () => {
  it("범위를 지정하지 않으면 전부 통과 (필터 미적용과 같다)", () => {
    expect(inAnyPathScope("anything.md", undefined)).toBe(true);
    expect(inAnyPathScope("anything.md", [])).toBe(true);
  });

  it("여러 범위 중 하나라도 걸리면 통과", () => {
    expect(inAnyPathScope("Docs/a.md", ["Notes", "Docs"])).toBe(true);
  });

  it("어느 범위에도 안 걸리면 제외 — 이웃 이름에 속지 않는다", () => {
    expect(inAnyPathScope("Notes-archive/a.md", ["Notes", "Docs"])).toBe(false);
    expect(inAnyPathScope("Other/a.md", ["Notes", "Docs"])).toBe(false);
  });
});
