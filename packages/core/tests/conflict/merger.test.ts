import { describe, it, expect } from "vitest";
import { threeWayMerge } from "../../src/conflict/merger.js";

describe("threeWayMerge", () => {
  it("다른 영역 수정 → 자동 병합 성공", () => {
    const base = "line1\nline2\nline3\nline4\nline5";
    const local = "line1\nMODIFIED\nline3\nline4\nline5";
    const remote = "line1\nline2\nline3\nline4\nCHANGED";

    const result = threeWayMerge(base, local, remote);

    expect(result.success).toBe(true);
    expect(result.merged).toContain("MODIFIED");
    expect(result.merged).toContain("CHANGED");
    expect(result.conflicts).toHaveLength(0);
  });

  it("동일 영역 다르게 수정 → 충돌", () => {
    const base = "line1\noriginal\nline3";
    const local = "line1\nlocal version\nline3";
    const remote = "line1\nremote version\nline3";

    const result = threeWayMerge(base, local, remote);

    expect(result.success).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.merged).toContain("<<<<<<< LOCAL");
    expect(result.merged).toContain(">>>>>>> REMOTE");
  });

  it("한쪽만 수정 → 수정된 쪽 반영", () => {
    const base = "line1\nline2\nline3";
    const local = "line1\nmodified\nline3";
    const remote = "line1\nline2\nline3";

    const result = threeWayMerge(base, local, remote);

    expect(result.success).toBe(true);
    expect(result.merged).toContain("modified");
  });

  it("양쪽 동일하게 수정 → 충돌 없음", () => {
    const base = "line1\nold\nline3";
    const local = "line1\nnew\nline3";
    const remote = "line1\nnew\nline3";

    const result = threeWayMerge(base, local, remote);

    expect(result.success).toBe(true);
    expect(result.merged).toContain("new");
  });

  it("빈 base → 양쪽 모두 새 내용이면 충돌", () => {
    const base = "";
    const local = "local content";
    const remote = "remote content";

    const result = threeWayMerge(base, local, remote);

    expect(result.success).toBe(false);
  });
});
