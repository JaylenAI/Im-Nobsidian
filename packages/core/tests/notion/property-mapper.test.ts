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

  // 결함10: Notion 이 빈 배열형 속성을 문서화된 `[]` 가 아니라 빈 객체 `{}` 로 돌려주는
  // 행이 실제로 존재한다(data source 분리 모델). 가드가 없으면 `{}.map` → "X.map is not
  // a function" 으로 그 행 전체가 pull 실패 → 영구 손실 + repull churn. 모든 배열 추출이
  // 어떤 형태에도 크래시 없이 안전한 빈/스칼라 값으로 강등돼야 한다.
  describe("fromNotionProperties — 비배열 속성값 하드닝 (결함10)", () => {
    it("multi_select 가 빈 객체 {} 여도 크래시 없이 빈 배열", () => {
      const call = () =>
        mapper.fromNotionProperties({ tags: { type: "multi_select", multi_select: {} } });
      expect(call).not.toThrow();
      expect(call().tags).toEqual([]);
    });

    it("rich_text 가 빈 객체 {} 여도 크래시 없이 null", () => {
      const result = mapper.fromNotionProperties({
        note: { type: "rich_text", rich_text: {} },
      });
      expect(result.note).toBeNull(); // 빈 rich_text 의 기존 동작과 동일
    });

    it("people 가 빈 객체 {} 여도 크래시 없이 빈 배열", () => {
      const result = mapper.fromNotionProperties({
        assignee: { type: "people", people: {} },
      });
      expect(result.assignee).toEqual([]);
    });

    it("relation 이 빈 객체 {} 여도 크래시 없이 빈 배열", () => {
      const result = mapper.fromNotionProperties({
        rel: { type: "relation", relation: {} },
      });
      expect(result.rel).toEqual([]);
    });

    it("files 가 빈 객체 {} 여도 크래시 없이 빈 배열", () => {
      const result = mapper.fromNotionProperties({
        docs: { type: "files", files: {} },
      });
      expect(result.docs).toEqual([]);
    });

    it("rollup.array 가 비배열이어도 크래시 없이 빈 배열", () => {
      const result = mapper.fromNotionProperties({
        sum: { type: "rollup", rollup: { type: "array", array: {} } },
      });
      expect(result.sum).toEqual([]);
    });

    it("unique_id 가 빈 객체 {} 면 'undefined' 문자열이 새지 않고 null", () => {
      const result = mapper.fromNotionProperties({
        id: { type: "unique_id", unique_id: {} },
      });
      expect(result.id).toBeNull(); // "undefined" 문자열이 아니라 null 이어야 한다
    });

    it("여러 비배열 속성이 섞인 행 전체가 크래시 없이 매핑된다(실Notion 프로덕트위키 케이스)", () => {
      const call = () =>
        mapper.fromNotionProperties({
          tags: { type: "multi_select", multi_select: {} },
          note: { type: "rich_text", rich_text: {} },
          assignee: { type: "people", people: {} },
          done: { type: "checkbox", checkbox: false },
        });
      expect(call).not.toThrow();
      const r = call();
      expect(r.tags).toEqual([]);
      expect(r.done).toBe(false); // 정상 속성은 그대로 보존
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

  describe("라운드트립 충실도 — 전 writable 타입 홀리스틱 (B3 · I3)", () => {
    // Notion READ props → fromNotionProperties → frontmatter → toNotionProperties → WRITE props.
    // READ/WRITE 형식이 다르므로(`{type,select}` vs `{select}`) 의미가 보존되는지 WRITE 페이로드로
    // 단언한다. relation(양방향 해석)·date-with-end·files 까지 한 번에 검증해 무손실을 잠근다.
    const PID_A = "11111111-1111-1111-1111-111111111111";
    const PID_B = "22222222-2222-2222-2222-222222222222";
    const ID_TO_TITLE: Record<string, string> = {
      [PID_A]: "Project Plan",
      [PID_B]: "Architecture",
    };
    const TITLE_TO_ID: Record<string, string> = {
      "Project Plan": PID_A,
      Architecture: PID_B,
    };

    beforeEach(() => {
      mapper.setWikilinkResolver({
        resolve: (t) => TITLE_TO_ID[t] ?? null,
        resolvePageId: (i) => ID_TO_TITLE[i] ?? null,
      });
      mapper.loadSchema({
        note: { id: "1", type: "rich_text" },
        priority: { id: "2", type: "number" },
        status: { id: "3", type: "select" },
        tags: { id: "4", type: "multi_select" },
        done: { id: "5", type: "checkbox" },
        due: { id: "6", type: "date" },
        span: { id: "7", type: "date" },
        link: { id: "8", type: "url" },
        mail: { id: "9", type: "email" },
        tel: { id: "10", type: "phone_number" },
        phase: { id: "11", type: "status" },
        related: { id: "12", type: "relation" },
        cover: { id: "13", type: "files" },
      });
    });

    function readToWrite(read: Record<string, unknown>): Record<string, unknown> {
      const fm = mapper.fromNotionProperties(read);
      const write = mapper.toNotionProperties(fm, "T");
      delete write.title; // title 은 본문에서 옴 — 속성 왕복 대상 아님
      return write;
    }

    it("13개 writable 타입 한 번에 무손실(deep-equal)", () => {
      const read = {
        note: { type: "rich_text", rich_text: [{ plain_text: "텍스트 2026-05-29 마감" }] },
        priority: { type: "number", number: 0 },
        status: { type: "select", select: { name: "active" } },
        tags: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] },
        done: { type: "checkbox", checkbox: false },
        due: { type: "date", date: { start: "2026-06-30" } },
        span: { type: "date", date: { start: "2026-01-01", end: "2026-12-31" } },
        link: { type: "url", url: "https://x.com" },
        mail: { type: "email", email: "a@b.com" },
        tel: { type: "phone_number", phone_number: "010-1234-5678" },
        phase: { type: "status", status: { name: "In Progress" } },
        related: { type: "relation", relation: [{ id: PID_A }, { id: PID_B }] },
        cover: {
          type: "files",
          files: [{ name: "n", type: "external", external: { url: "https://cdn.x/a.jpg" } }],
        },
      };

      expect(readToWrite(read)).toEqual({
        note: { rich_text: [{ text: { content: "텍스트 2026-05-29 마감" } }] },
        priority: { number: 0 },
        status: { select: { name: "active" } },
        tags: { multi_select: [{ name: "a" }, { name: "b" }] },
        done: { checkbox: false },
        due: { date: { start: "2026-06-30", end: null } },
        span: { date: { start: "2026-01-01", end: "2026-12-31" } },
        link: { url: "https://x.com" },
        mail: { email: "a@b.com" },
        tel: { phone_number: "010-1234-5678" },
        phase: { status: { name: "In Progress" } },
        related: { relation: [{ id: PID_A }, { id: PID_B }] },
        // files 의 name 은 URL 로 직렬화된다(Bases image 렌더 호환) — url 자체는 보존.
        cover: {
          files: [
            {
              type: "external",
              name: "https://cdn.x/a.jpg",
              external: { url: "https://cdn.x/a.jpg" },
            },
          ],
        },
      });
    });

    it("relation: 해석기 없어도 raw id 로 왕복(미인덱싱 페이지 보존)", () => {
      mapper.setWikilinkResolver({ resolve: () => null, resolvePageId: () => null });
      const read = { related: { type: "relation", relation: [{ id: PID_A }] } };
      // 해석기가 title 을 못 찾으면 from 은 raw id 를 남기고, to 는 uuid 를 그대로 전송.
      expect(readToWrite(read)).toEqual({ related: { relation: [{ id: PID_A }] } });
    });

    it("date with time/timezone: 초·밀리초·타임존 보존", () => {
      const iso = "2026-05-29T14:30:00.000+09:00";
      const read = { due: { type: "date", date: { start: iso } } };
      expect(readToWrite(read)).toEqual({ due: { date: { start: iso, end: null } } });
    });
  });
});
