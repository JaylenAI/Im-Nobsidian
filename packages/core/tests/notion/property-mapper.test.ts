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
      expect(result.due).toEqual({ date: { start: "2026-06-30", end: null } });
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

  describe("toNotionProperties — 읽기전용 속성 스킵", () => {
    beforeEach(() => {
      mapper.loadSchema({
        created: { id: "a", type: "created_time" },
        edited: { id: "b", type: "last_edited_time" },
        creator: { id: "c", type: "created_by" },
        editor: { id: "d", type: "last_edited_by" },
        calc: { id: "e", type: "formula" },
        summary: { id: "f", type: "rollup" },
        uid: { id: "g", type: "unique_id" },
        verify: { id: "h", type: "verification" },
        name: { id: "i", type: "rich_text" },
      });
    });

    it("읽기전용 속성은 변환 결과에 포함되지 않음", () => {
      const result = mapper.toNotionProperties(
        {
          created: "2026-01-01",
          edited: "2026-05-15",
          creator: "Alice",
          editor: "Bob",
          calc: "computed",
          summary: "rolled up",
          uid: "TASK-1",
          verify: "verified",
          name: "유효한 값",
        },
        "Test",
      );
      expect(result.created).toBeUndefined();
      expect(result.edited).toBeUndefined();
      expect(result.creator).toBeUndefined();
      expect(result.editor).toBeUndefined();
      expect(result.calc).toBeUndefined();
      expect(result.summary).toBeUndefined();
      expect(result.uid).toBeUndefined();
      expect(result.verify).toBeUndefined();
      expect(result.name).toEqual({ rich_text: [{ text: { content: "유효한 값" } }] });
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
      expect(result.created).toEqual({ date: { start: "2026-01-15", end: null } });
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

    it("date → 문자열 (end 없을 때)", () => {
      const result = mapper.fromNotionProperties({
        due: { type: "date", date: { start: "2026-06-30" } },
      });
      expect(result.due).toBe("2026-06-30");
    });

    it("date → 객체 (end 있을 때)", () => {
      const result = mapper.fromNotionProperties({
        due: { type: "date", date: { start: "2026-01-01", end: "2026-12-31" } },
      });
      expect(result.due).toEqual({ start: "2026-01-01", end: "2026-12-31" });
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

    it("created_by → 이름", () => {
      const result = mapper.fromNotionProperties({
        creator: { type: "created_by", created_by: { id: "user1", name: "Alice" } },
      });
      expect(result.creator).toBe("Alice");
    });

    it("last_edited_by → 이름", () => {
      const result = mapper.fromNotionProperties({
        editor: { type: "last_edited_by", last_edited_by: { id: "user2", name: "Bob" } },
      });
      expect(result.editor).toBe("Bob");
    });

    it("created_by 이름 없으면 id 반환", () => {
      const result = mapper.fromNotionProperties({
        creator: { type: "created_by", created_by: { id: "user1" } },
      });
      expect(result.creator).toBe("user1");
    });

    it("verification → state 문자열", () => {
      const result = mapper.fromNotionProperties({
        verified: { type: "verification", verification: { state: "verified" } },
      });
      expect(result.verified).toBe("verified");
    });

    it("files: 단일 외부 파일 → 스칼라 URL 문자열 (Bases image 렌더용)", () => {
      const result = mapper.fromNotionProperties({
        이미지: {
          type: "files",
          files: [
            { name: "thumb", type: "external", external: { url: "https://cdn.x.com/a.jpg" } },
          ],
        },
      });
      // 스칼라 문자열이어야 Obsidian Bases 카드 image: 가 렌더한다 ([{name,url}] 배열은 렌더 안됨)
      expect(result.이미지).toBe("https://cdn.x.com/a.jpg");
    });

    it("files: 복수 파일 → URL 문자열 배열", () => {
      const result = mapper.fromNotionProperties({
        docs: {
          type: "files",
          files: [
            { name: "a", type: "external", external: { url: "https://x.com/a.pdf" } },
            { name: "b", type: "file", file: { url: "https://s3.x.com/b.pdf" } },
          ],
        },
      });
      expect(result.docs).toEqual(["https://x.com/a.pdf", "https://s3.x.com/b.pdf"]);
    });

    it("files: 빈 목록 → 빈 배열", () => {
      const result = mapper.fromNotionProperties({ docs: { type: "files", files: [] } });
      expect(result.docs).toEqual([]);
    });

    it("files: fromNotion 스칼라 URL → toNotion 라운드트립(external)", () => {
      mapper.loadSchema({ 이미지: { id: "x", type: "files" } });
      const fm = mapper.fromNotionProperties({
        이미지: {
          type: "files",
          files: [{ name: "t", type: "external", external: { url: "https://cdn.x.com/a.jpg" } }],
        },
      });
      const back = mapper.toNotionProperties({ 이미지: fm.이미지 }, "T");
      expect(back.이미지).toEqual({
        files: [
          {
            type: "external",
            name: "https://cdn.x.com/a.jpg",
            external: { url: "https://cdn.x.com/a.jpg" },
          },
        ],
      });
    });
  });

  describe("toNotionProperties — 입력 검증/하드닝 (Phase 2b)", () => {
    beforeEach(() => {
      mapper.loadSchema({
        due: { id: "a", type: "date" },
        note: { id: "b", type: "rich_text" },
        priority: { id: "c", type: "number" },
        status: { id: "d", type: "select" },
        phase: { id: "e", type: "status" },
        tags: { id: "f", type: "multi_select" },
        attachments: { id: "g", type: "files" },
      });
    });

    it("date: 날짜로 시작하는 일반 텍스트를 date 로 오분류하지 않음", () => {
      // 스키마가 rich_text 인 키에 날짜로 시작하는 텍스트 → 그대로 보존
      const result = mapper.toNotionProperties({ note: "2026-05-29 프로젝트 마감" }, "T");
      expect(result.note).toEqual({
        rich_text: [{ text: { content: "2026-05-29 프로젝트 마감" } }],
      });
    });

    it("date: 잘못된 날짜 문자열은 전송하지 않음(null)", () => {
      const result = mapper.toNotionProperties({ due: "2026-05-29 마감" }, "T");
      expect(result.due).toBeUndefined();
    });

    it("date: 초/밀리초/타임존 포함 ISO datetime 라운드트립 보존", () => {
      const iso = "2026-05-29T14:30:00.000+09:00";
      const result = mapper.toNotionProperties({ due: iso }, "T");
      expect(result.due).toEqual({ date: { start: iso, end: null } });
    });

    it("number: 숫자로 변환 불가한 값은 NaN 대신 스킵", () => {
      const result = mapper.toNotionProperties({ priority: "높음" }, "T");
      expect(result.priority).toBeUndefined();
    });

    it("number: 0 은 정상 전송", () => {
      const result = mapper.toNotionProperties({ priority: 0 }, "T");
      expect(result.priority).toEqual({ number: 0 });
    });

    it("select: 빈/공백 이름은 스킵", () => {
      expect(mapper.toNotionProperties({ status: "" }, "T").status).toBeUndefined();
      expect(mapper.toNotionProperties({ status: "   " }, "T").status).toBeUndefined();
    });

    it("status: 빈 이름은 스킵", () => {
      expect(mapper.toNotionProperties({ phase: "" }, "T").phase).toBeUndefined();
    });

    it("multi_select: 빈 옵션 이름 제거", () => {
      const result = mapper.toNotionProperties({ tags: "a,,b, ,c" }, "T");
      expect(result.tags).toEqual({
        multi_select: [{ name: "a" }, { name: "b" }, { name: "c" }],
      });
    });

    it("files: 빈 URL 항목 제거", () => {
      const result = mapper.toNotionProperties(
        {
          attachments: [
            { name: "ok", url: "https://x.com/a.pdf" },
            { name: "bad", url: "" },
          ],
        },
        "T",
      );
      expect(result.attachments).toEqual({
        files: [{ type: "external", name: "ok", external: { url: "https://x.com/a.pdf" } }],
      });
    });
  });

  describe("라운드트립 충실도 (from→to)", () => {
    beforeEach(() => {
      mapper.loadSchema({
        status: { id: "a", type: "select" },
        tags: { id: "b", type: "multi_select" },
        priority: { id: "c", type: "number" },
        done: { id: "d", type: "checkbox" },
        due: { id: "e", type: "date" },
      });
    });

    it("select/multi_select/number/checkbox/date 왕복 일치", () => {
      const notion = {
        status: { type: "select", select: { name: "active" } },
        tags: { type: "multi_select", multi_select: [{ name: "x" }, { name: "y" }] },
        priority: { type: "number", number: 0 },
        done: { type: "checkbox", checkbox: false },
        due: { type: "date", date: { start: "2026-06-30" } },
      };
      const fm = mapper.fromNotionProperties(notion);
      const back = mapper.toNotionProperties(fm, "Title");

      expect(back.status).toEqual({ select: { name: "active" } });
      expect(back.tags).toEqual({ multi_select: [{ name: "x" }, { name: "y" }] });
      expect(back.priority).toEqual({ number: 0 });
      expect(back.done).toEqual({ checkbox: false });
      expect(back.due).toEqual({ date: { start: "2026-06-30", end: null } });
    });
  });
});
