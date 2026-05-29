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

  // --- diff3 정확도 (단순 라인-치환 방식이 거짓 충돌/유실을 내던 케이스) ---

  it("서로 다른 위치의 삽입 + 추가 → 거짓 충돌 없이 병합", () => {
    // local 은 a 다음에 X 삽입, remote 는 끝에 Y 추가. 충돌이 아니어야 한다.
    const base = "a\nb\nc";
    const local = "a\nX\nb\nc";
    const remote = "a\nb\nc\nY";

    const result = threeWayMerge(base, local, remote);

    expect(result.success).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    expect(result.merged).toBe("a\nX\nb\nc\nY");
  });

  it("한쪽 삭제 + 다른 쪽 다른 줄 수정 → 병합 성공", () => {
    // local 은 b 를 삭제, remote 는 d 를 수정. 겹치지 않으므로 자동 병합.
    const base = "a\nb\nc\nd";
    const local = "a\nc\nd";
    const remote = "a\nb\nc\nD";

    const result = threeWayMerge(base, local, remote);

    expect(result.success).toBe(true);
    expect(result.merged).toBe("a\nc\nD");
  });

  it("양쪽이 같은 줄을 삽입 → 충돌 없이 한 번만 반영", () => {
    const base = "a\nc";
    const local = "a\nb\nc";
    const remote = "a\nb\nc";

    const result = threeWayMerge(base, local, remote);

    expect(result.success).toBe(true);
    expect(result.merged).toBe("a\nb\nc");
  });

  it("여러 블록의 독립 수정 → 모두 반영, 충돌 없음", () => {
    const base = "h1\np1\nh2\np2\nh3\np3";
    const local = "h1\nP1-LOCAL\nh2\np2\nh3\np3";
    const remote = "h1\np1\nh2\np2\nh3\nP3-REMOTE";

    const result = threeWayMerge(base, local, remote);

    expect(result.success).toBe(true);
    expect(result.merged).toBe("h1\nP1-LOCAL\nh2\np2\nh3\nP3-REMOTE");
  });

  it("인접 줄을 양쪽이 다르게 수정 → 충돌 1건", () => {
    const base = "a\nb\nc\nd";
    const local = "a\nB-LOCAL\nC-LOCAL\nd";
    const remote = "a\nB-REMOTE\nC-REMOTE\nd";

    const result = threeWayMerge(base, local, remote);

    expect(result.success).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.localLines).toEqual(["B-LOCAL", "C-LOCAL"]);
    expect(result.conflicts[0]!.remoteLines).toEqual(["B-REMOTE", "C-REMOTE"]);
    // 충돌 바깥의 공통 줄(a, d)은 그대로 보존되어야 한다.
    expect(result.merged.startsWith("a\n")).toBe(true);
    expect(result.merged.endsWith("\nd")).toBe(true);
  });

  it("base 와 동일한 local/remote → 변경 없이 그대로", () => {
    const base = "a\nb\nc";
    const result = threeWayMerge(base, base, base);

    expect(result.success).toBe(true);
    expect(result.merged).toBe(base);
  });

  it("대용량(1000줄)에서 각각 다른 위치 수정 → 자동 병합", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line-${i}`);
    const base = lines.join("\n");
    const localArr = [...lines];
    localArr[10] = "LOCAL-EDIT";
    const remoteArr = [...lines];
    remoteArr[900] = "REMOTE-EDIT";

    const result = threeWayMerge(base, localArr.join("\n"), remoteArr.join("\n"));

    expect(result.success).toBe(true);
    expect(result.merged).toContain("LOCAL-EDIT");
    expect(result.merged).toContain("REMOTE-EDIT");
  });
});
