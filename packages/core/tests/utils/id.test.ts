import { describe, it, expect } from "vitest";
import { generateId, normalizeNotionId, notionIdsEqual } from "../../src/utils/id.js";

describe("generateId", () => {
  it("UUID 형식 생성", () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("매번 고유한 ID", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe("normalizeNotionId", () => {
  it("대시 없는 ID를 대시 포함 UUID로 변환", () => {
    const raw = "35a13b18d38280cf9057e37e6e473e41";
    const result = normalizeNotionId(raw);
    expect(result).toBe("35a13b18-d382-80cf-9057-e37e6e473e41");
  });

  it("이미 대시가 있는 ID는 그대로 반환", () => {
    const id = "35a13b18-d382-80cf-9057-e37e6e473e41";
    expect(normalizeNotionId(id)).toBe("35a13b18-d382-80cf-9057-e37e6e473e41");
  });

  it("잘못된 길이의 ID는 그대로 반환", () => {
    expect(normalizeNotionId("short")).toBe("short");
    expect(normalizeNotionId("")).toBe("");
  });
});

describe("notionIdsEqual", () => {
  it("같은 ID의 다른 형식 비교", () => {
    expect(
      notionIdsEqual("35a13b18d38280cf9057e37e6e473e41", "35a13b18-d382-80cf-9057-e37e6e473e41"),
    ).toBe(true);
  });

  it("같은 형식의 같은 ID", () => {
    expect(
      notionIdsEqual(
        "35a13b18-d382-80cf-9057-e37e6e473e41",
        "35a13b18-d382-80cf-9057-e37e6e473e41",
      ),
    ).toBe(true);
  });

  it("다른 ID", () => {
    expect(
      notionIdsEqual("35a13b18d38280cf9057e37e6e473e41", "aaaabbbbccccddddeeee111122223333"),
    ).toBe(false);
  });
});
