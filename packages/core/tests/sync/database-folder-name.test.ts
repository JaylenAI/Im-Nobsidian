import { describe, it, expect } from "vitest";
import { databaseFolderName } from "../../src/sync/database-discovery.js";

describe("databaseFolderName — DB 제목 → 볼트 폴더 이름", () => {
  it("예전 이름 그대로 — 쓸 수 없는 글자를 빼고 공백은 하이픈", () => {
    expect(databaseFolderName("독서 기록 (2026)")).toBe("독서-기록-2026");
  });

  it("255 바이트를 넘으면 자른다 — 넘는 폴더는 만들 수 없다", () => {
    const name = databaseFolderName("가".repeat(100));
    expect(name).toBe("가".repeat(85));
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
  });
});
