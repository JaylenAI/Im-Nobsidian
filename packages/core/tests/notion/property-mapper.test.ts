import { describe, it, expect, beforeEach } from "vitest";
import { PropertyMapper } from "../../src/notion/property-mapper.js";

describe("PropertyMapper", () => {
  let mapper: PropertyMapper;

  beforeEach(() => {
    mapper = new PropertyMapper();
  });

  describe("toNotionProperties — 스키마 기반 변환", () => {
    beforeEach(() => {
      mapper.loadSchema({
        status: { id: "abc", type: "select" },
        tags: { id: "def", type: "multi_select" },
        priority: { id: "ghi", type: "number" },
        reviewed: { id: "jkl", type: "checkbox" },
        due: { id: "mno", type: "date" },
        link: { id: "pqr", type: "url" },
        note: { id: "stu", type: "rich_text" },
        phase: { id: "vwx", type: "status" },
      });
    });

    it("title 속성은 항상 포함", () => {
      const result = mapper.toNotionProperties({}, "My Note");
      expect(result.title).toEqual({
        title: [{ text: { content: "My Note" } }],
      });
    });

    it("select 속성 변환", () => {
      const result = mapper.toNotionProperties({ status: "active" }, "Test");
      expect(result.status).toEqual({ select: { name: "active" } });
    });

    it("multi_select 속성 변환 (배열)", () => {
      const result = mapper.toNotionProperties({ tags: ["a", "b", "c"] }, "Test");
      expect(result.tags).toEqual({
        multi_select: [{ name: "a" }, { name: "b" }, { name: "c" }],
      });
    });

    it("number 속성 변환", () => {
      const result = mapper.toNotionProperties({ priority: 5 }, "Test");
      expect(result.priority).toEqual({ number: 5 });
    });

    it("checkbox 속성 변환", () => {
      const result = mapper.toNotionProperties({ reviewed: true }, "Test");
      expect(result.reviewed).toEqual({ checkbox: true });
    });

    it("date 속성 변환", () => {
      const result = mapper.toNotionProperties({ due: "2026-06-30" }, "Test");
      expect(result.due).toEqual({ date: { start: "2026-06-30" } });
    });

    it("url 속성 변환", () => {
      const result = mapper.toNotionProperties({ link: "https://github.com" }, "Test");
      expect(result.link).toEqual({ url: "https://github.com" });
    });

    it("rich_text 속성 변환", () => {
      const result = mapper.toNotionProperties({ note: "Hello" }, "Test");
      expect(result.note).toEqual({
        rich_text: [{ text: { content: "Hello" } }],
      });
    });

    it("status 속성 변환", () => {
      const result = mapper.toNotionProperties({ phase: "In Progress" }, "Test");
      expect(result.phase).toEqual({ status: { name: "In Progress" } });
    });

    it("title 키는 프론트매터에서 제외", () => {
      const result = mapper.toNotionProperties({ title: "Ignored" }, "Real Title");
      expect(result.title).toEqual({
        title: [{ text: { content: "Real Title" } }],
      });
    });
  });

  describe("toNotionProperties — 타입 추론 변환", () => {
    it("boolean → checkbox", () => {
      const result = mapper.toNotionProperties({ active: true }, "Test");
      expect(result.active).toEqual({ checkbox: true });
    });

    it("number → number", () => {
      const result = mapper.toNotionProperties({ count: 42 }, "Test");
      expect(result.count).toEqual({ number: 42 });
    });

    it("배열 → multi_select", () => {
      const result = mapper.toNotionProperties({ items: ["x", "y"] }, "Test");
      expect(result.items).toEqual({
        multi_select: [{ name: "x" }, { name: "y" }],
      });
    });

    it("날짜 문자열 → date", () => {
      const result = mapper.toNotionProperties({ created: "2026-01-15" }, "Test");
      expect(result.created).toEqual({ date: { start: "2026-01-15" } });
    });

    it("URL 문자열 → url", () => {
      const result = mapper.toNotionProperties({ homepage: "https://example.com" }, "Test");
      expect(result.homepage).toEqual({ url: "https://example.com" });
    });

    it("일반 문자열 → rich_text", () => {
      const result = mapper.toNotionProperties({ desc: "plain text" }, "Test");
      expect(result.desc).toEqual({
        rich_text: [{ text: { content: "plain text" } }],
      });
    });
  });

  describe("fromNotionProperties", () => {
    it("select → 문자열", () => {
      const result = mapper.fromNotionProperties({
        status: { type: "select", select: { name: "active" } },
      });
      expect(result.status).toBe("active");
    });

    it("multi_select → 배열", () => {
      const result = mapper.fromNotionProperties({
        tags: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] },
      });
      expect(result.tags).toEqual(["a", "b"]);
    });

    it("number → 숫자", () => {
      const result = mapper.fromNotionProperties({
        priority: { type: "number", number: 5 },
      });
      expect(result.priority).toBe(5);
    });

    it("checkbox → boolean", () => {
      const result = mapper.fromNotionProperties({
        done: { type: "checkbox", checkbox: true },
      });
      expect(result.done).toBe(true);
    });

    it("date → 객체", () => {
      const result = mapper.fromNotionProperties({
        due: { type: "date", date: { start: "2026-06-30" } },
      });
      expect(result.due).toEqual({ start: "2026-06-30" });
    });

    it("url → 문자열", () => {
      const result = mapper.fromNotionProperties({
        link: { type: "url", url: "https://github.com" },
      });
      expect(result.link).toBe("https://github.com");
    });

    it("rich_text → 문자열", () => {
      const result = mapper.fromNotionProperties({
        note: { type: "rich_text", rich_text: [{ plain_text: "Hello" }] },
      });
      expect(result.note).toBe("Hello");
    });

    it("title 속성은 제외", () => {
      const result = mapper.fromNotionProperties({
        Title: { type: "title", title: [{ plain_text: "My Note" }] },
        status: { type: "select", select: { name: "active" } },
      });
      expect(result.Title).toBeUndefined();
      expect(result.status).toBe("active");
    });

    it("unique_id 변환", () => {
      const result = mapper.fromNotionProperties({
        id: { type: "unique_id", unique_id: { prefix: "TASK", number: 42 } },
      });
      expect(result.id).toBe("TASK-42");
    });

    it("people → 이름 배열", () => {
      const result = mapper.fromNotionProperties({
        assignee: {
          type: "people",
          people: [
            { id: "user1", name: "Alice" },
            { id: "user2", name: "Bob" },
          ],
        },
      });
      expect(result.assignee).toEqual(["Alice", "Bob"]);
    });
  });
});
