import { describe, it, expect } from "vitest";
import {
  generateId,
  isNotionId,
  normalizeNotionId,
  notionIdFromInput,
  notionIdsEqual,
  shortNotionId,
} from "../../src/utils/id.js";

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

describe("isNotionId", () => {
  it("대시 있는 UUID 와 32 hex 를 알아본다(대소문자 무관)", () => {
    expect(isNotionId("35a13b18-d382-80cf-9057-e37e6e473e41")).toBe(true);
    expect(isNotionId("35A13B18D38280CF9057E37E6E473E41")).toBe(true);
  });

  it("값의 일부만 ID 이거나 모양이 다르면 아니다", () => {
    expect(isNotionId("[[35a13b18d38280cf9057e37e6e473e41]]")).toBe(false);
    expect(isNotionId("35a13b18d38280cf9057e37e6e473e4")).toBe(false);
    expect(isNotionId("홍길동")).toBe(false);
  });
});

describe("notionIdFromInput — 설정에 넣은 루트 페이지 (D1)", () => {
  const ID = "35a13b18-d382-80cf-9057-e37e6e473e41";
  const RAW = "35a13b18d38280cf9057e37e6e473e41";
  const VIEW = "11112222333344445555666677778888";

  it.each([
    ["대시 없는 ID", RAW],
    ["대시 있는 ID · 앞뒤 공백 · 대문자", `  ${ID.toUpperCase()} `],
    ["주소창 주소", `https://www.notion.so/myspace/회의-기록-${RAW}`],
    ["주소창 주소 · 꼬리 질의", `https://www.notion.so/myspace/Notes-${RAW}?pvs=4`],
    ["짧은 주소", `https://www.notion.so/${RAW}`],
    ["공개 사이트 주소", `https://myspace.notion.site/Notes-${RAW}#heading`],
    [
      "DB 보기에서 연 페이지 — 보기 ID 가 아니라 연 페이지",
      `https://www.notion.so/${VIEW}?v=${VIEW}&p=${RAW}&pm=s`,
    ],
  ])("%s → 페이지 ID", (_name, input) => {
    expect(notionIdFromInput(input)).toBe(ID);
  });

  it.each([
    ["빈 값", ""],
    ["ID 가 아닌 글", "root"],
    ["한 자 모자란 ID", RAW.slice(1)],
    ["ID 없는 주소", "https://www.notion.so/myspace/Notes"],
    ["연 페이지 자리가 ID 가 아님", `https://www.notion.so/${RAW}?p=abc`],
  ])("%s → 못 찾음", (_name, input) => {
    expect(notionIdFromInput(input)).toBeNull();
  });
});

describe("shortNotionId", () => {
  it("대시 · 대문자와 상관없이 앞 8자", () => {
    expect(shortNotionId("ABCDEF12-3456-7890-abcd-ef1234567890")).toBe("abcdef12");
    expect(shortNotionId("abcdef1234567890abcdef1234567890")).toBe("abcdef12");
  });
});
