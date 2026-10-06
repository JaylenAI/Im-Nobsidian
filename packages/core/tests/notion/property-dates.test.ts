import { describe, expect, it } from "vitest";
import { PropertyMapper } from "../../src/notion/property-mapper.js";
import { FrontmatterGenerator } from "../../src/converter/post-processors/frontmatter-generator.js";
import { ConfigSchema, DEFAULT_CONFIG } from "../../src/types/config.js";
import { splitFrontmatter, stringifyFrontmatter } from "../../src/utils/frontmatter.js";

// 시간대는 모두 이름으로 준다 — 이 컴퓨터(KST) 와 CI(UTC) 에서 같은 답이어야 한다.
const ZONE = "Asia/Seoul";

function seoulMapper(schema: Record<string, string> = {}): PropertyMapper {
  const mapper = new PropertyMapper({ timeZone: ZONE });
  mapper.loadSchema(
    Object.fromEntries(Object.entries(schema).map(([name, type]) => [name, { id: name, type }])),
  );
  return mapper;
}

const date = (start: string, end: string | null = null) => ({
  type: "date",
  date: { start, end, time_zone: null },
});

describe("pull — 날짜는 Obsidian 이 아는 모양으로 (F-08)", () => {
  it("시각은 설정 시간대의 벽시계 시각(`YYYY-MM-DDTHH:mm`) · 날짜는 그대로", () => {
    const fm = seoulMapper().fromNotionProperties({
      마감: date("2026-10-01T01:00:00.000+00:00"),
      시작: date("2026-10-01"),
    });
    expect(fm).toEqual({ 마감: "2026-10-01T10:00", 시작: "2026-10-01" });
  });

  it("기간은 시작을 그 키에, 끝을 `_end` 키에 — 끝이 없으면 `_end` 를 적지 않는다", () => {
    const fm = seoulMapper().fromNotionProperties({
      기간: date("2026-10-01T00:00:00.000+00:00", "2026-10-03T09:30:00.000+00:00"),
      하루: date("2026-10-05"),
    });
    expect(fm).toEqual({
      기간: "2026-10-01T09:00",
      기간_end: "2026-10-03T18:30",
      하루: "2026-10-05",
    });
  });

  it("`_end` 이름의 속성이 따로 있으면 기간을 가르지 않는다 — 그 속성을 덮지 않게", () => {
    const fm = seoulMapper().fromNotionProperties({
      기간: date("2026-10-01", "2026-10-03"),
      기간_end: { type: "rich_text", rich_text: [{ plain_text: "따로 적은 끝" }] },
    });
    expect(fm).toEqual({
      기간: { start: "2026-10-01", end: "2026-10-03" },
      기간_end: "따로 적은 끝",
    });
  });

  it("생성 · 수정 시각 · 수식 · 롤업의 날짜도 같은 모양이다", () => {
    const fm = seoulMapper().fromNotionProperties({
      생성일: { type: "created_time", created_time: "2026-10-04T14:44:00.000Z" },
      수정일: { type: "last_edited_time", last_edited_time: "2026-10-04T15:00:00.000Z" },
      계산: {
        type: "formula",
        formula: { type: "date", date: { start: "2026-10-01T01:00:00.000+00:00", end: null } },
      },
      묶음: {
        type: "rollup",
        rollup: {
          type: "date",
          date: { start: "2026-10-01", end: "2026-10-09" },
          function: "date_range",
        },
      },
    });
    expect(fm).toEqual({
      생성일: "2026-10-04T23:44",
      수정일: "2026-10-05T00:00",
      계산: "2026-10-01T10:00",
      묶음: "2026-10-01",
      묶음_end: "2026-10-09",
    });
  });

  it("벽시계 시각은 frontmatter 에 따옴표 없이 적힌다 — Obsidian 이 날짜시각으로 읽는 모양", () => {
    const fm = seoulMapper().fromNotionProperties({
      마감: date("2026-10-01T01:00:00.000+00:00", "2026-10-02T01:00:00.000+00:00"),
    });
    const note = stringifyFrontmatter("본문\n", fm);
    expect(note).toBe("---\n마감: 2026-10-01T10:00\n마감_end: 2026-10-02T10:00\n---\n본문\n");
    // 다시 읽으면 같은 글이다 — 초가 없어 YAML timestamp 가 아니다.
    expect(splitFrontmatter(note).data).toEqual(fm);
  });
});

describe("push — 벽시계 시각에 시간대 오프셋을 붙이고, 짝 키는 한 속성으로 (F-08)", () => {
  const schema = { 마감: "date", 기간: "date", 메모: "rich_text" };

  it("새 행: 벽시계 시각은 오프셋을 붙이고 · 짝 키는 기간으로 · `_end` 는 속성으로 보내지 않는다", () => {
    const props = seoulMapper(schema).toNotionProperties(
      { 마감: "2026-10-01T10:00", 기간: "2026-10-01", 기간_end: "2026-10-03", 메모: "m" },
      "T",
    );
    expect(props.마감).toEqual({ date: { start: "2026-10-01T10:00:00+09:00", end: null } });
    expect(props.기간).toEqual({ date: { start: "2026-10-01", end: "2026-10-03" } });
    expect(props).not.toHaveProperty("기간_end");
  });

  it("예전 모양(`{start, end}` · 오프셋이 붙은 시각)도 그대로 받는다", () => {
    const props = seoulMapper(schema).toNotionProperties(
      { 마감: "2026-10-01T10:00:00.000+09:00", 기간: { start: "2026-10-01", end: "2026-10-03" } },
      "T",
    );
    expect(props.마감).toEqual({ date: { start: "2026-10-01T10:00:00.000+09:00", end: null } });
    expect(props.기간).toEqual({ date: { start: "2026-10-01", end: "2026-10-03" } });
  });

  it("YAML 이 날짜로 읽은 값(Date)도 날짜로 보낸다", () => {
    const { data } = splitFrontmatter("---\n기간: 2026-10-01\n기간_end: 2026-10-03\n---\n");
    expect(seoulMapper(schema).toNotionProperties(data, "T").기간).toEqual({
      date: { start: "2026-10-01", end: "2026-10-03" },
    });
  });

  it("끝만 바꿔도 시작과 함께 보낸다 — 날짜 값은 통째로 바뀐다", () => {
    const current = { 기간: "2026-10-01T09:00", 기간_end: "2026-10-03T18:30" };
    const { properties, skipped } = seoulMapper(schema).toNotionPropertyChanges(
      { changed: { 기간_end: "2026-10-03T18:30" }, cleared: [] },
      null,
      { current },
    );
    expect(properties).toEqual({
      기간: { date: { start: "2026-10-01T09:00:00+09:00", end: "2026-10-03T18:30:00+09:00" } },
    });
    expect(skipped).toEqual([]);
  });

  it("끝을 지우면 시작만 · 둘 다 지우면 날짜를 비운다", () => {
    const mapper = seoulMapper(schema);
    expect(
      mapper.toNotionPropertyChanges({ changed: {}, cleared: ["기간_end"] }, null, {
        current: { 기간: "2026-10-01" },
      }).properties,
    ).toEqual({ 기간: { date: { start: "2026-10-01", end: null } } });
    expect(
      mapper.toNotionPropertyChanges({ changed: {}, cleared: ["기간", "기간_end"] }, null, {
        current: {},
      }).properties,
    ).toEqual({ 기간: { date: null } });
  });

  it("시작 없이 끝만 있으면 보내지 않고 알린다 — Notion 날짜는 시작이 있어야 한다", () => {
    const { properties, skipped } = seoulMapper(schema).toNotionPropertyChanges(
      { changed: {}, cleared: ["기간"] },
      null,
      { current: { 기간_end: "2026-10-03" } },
    );
    expect(properties).toEqual({});
    expect(skipped).toEqual(["기간"]);
  });

  it("달력에 없는 시각은 보내지 않고 알린다 — 날짜를 지우는 요청이 되지 않게", () => {
    const { properties, skipped } = seoulMapper(schema).toNotionPropertyChanges(
      { changed: { 마감: "2026-02-30T10:00" }, cleared: [] },
      null,
      { current: { 마감: "2026-02-30T10:00" } },
    );
    expect(properties).toEqual({});
    expect(skipped).toEqual(["마감"]);
  });
});

describe("writableValues — 예전 모양과 새 모양을 같은 순간이면 같게 본다 (F-08)", () => {
  const schema = { 마감: "date", 기간: "date", 메모: "rich_text", 생성: "created_time" };

  it("오프셋이 붙은 시각 · `{start, end}` 를 벽시계 시각 · 짝 키로", () => {
    const mapper = seoulMapper(schema);
    const old = mapper.writableValues({
      마감: "2026-10-01T10:00:00.000+09:00",
      기간: { start: "2026-10-01T09:00:00.000+09:00", end: "2026-10-03T18:30:00.000+09:00" },
      메모: "m",
      생성: "2026-10-01T00:00:00.000Z",
      aliases: ["x"],
    });
    const remote = mapper.writableValues(
      mapper.fromNotionProperties({
        마감: date("2026-10-01T01:00:00.000+00:00"),
        기간: date("2026-10-01T00:00:00.000+00:00", "2026-10-03T09:30:00.000+00:00"),
        메모: { type: "rich_text", rich_text: [{ plain_text: "m" }] },
        생성: { type: "created_time", created_time: "2026-10-01T00:00:00.000Z" },
      }),
    );
    expect(old).toEqual(remote);
    expect(old).toEqual({
      마감: "2026-10-01T10:00",
      기간: "2026-10-01T09:00",
      기간_end: "2026-10-03T18:30",
      메모: "m",
    });
  });
});

describe("hasOutdatedDateForm — 예전 버전이 적은 날짜 모양이 남은 행 (F-08)", () => {
  const remote = {
    이름: { type: "title", title: [] },
    마감: date("2026-10-01T01:00:00.000+00:00"),
    기간: date("2026-10-01T00:00:00.000+00:00", "2026-10-03T09:30:00.000+00:00"),
    하루: date("2026-10-05"),
    빈날: { type: "date", date: null },
    생성일: { type: "created_time", created_time: "2026-10-04T14:44:00.000Z" },
    계산: {
      type: "formula",
      formula: { type: "date", date: { start: "2026-10-01", end: null, time_zone: null } },
    },
    묶음: {
      type: "rollup",
      rollup: { type: "array", array: [date("2026-10-01T01:00:00.000+00:00")] },
    },
    빈묶음: { type: "rollup", rollup: { type: "array", array: [] } },
    메모: { type: "rich_text", rich_text: [{ plain_text: "2026-10-04T14:44:00.000Z" }] },
  };
  /** 새 매퍼로 받아 적은 frontmatter 를 다시 읽은 값 — pull 이 적는 모양(빈 목록은 빠진다) · YAML 이 읽는 값. */
  const freshlyWritten = () => {
    const note = new FrontmatterGenerator().process({
      content: "",
      metadata: { properties: seoulMapper().fromNotionProperties(remote) },
      context: { direction: "pull", path: "markdown-api", filePath: "행.md" },
    }).content;
    return splitFrontmatter(note).data;
  };

  it("새 매퍼가 적은 frontmatter 는 예전 모양이 아니다 — 다시 받은 행을 또 고르지 않는다", () => {
    const written = freshlyWritten();
    expect(written).not.toHaveProperty("빈묶음");
    expect(written).toHaveProperty("빈날", null);
    expect(seoulMapper().hasOutdatedDateForm(written, remote)).toBe(false);
  });

  it.each([
    ["생성일 UTC", { 생성일: "2026-10-04T14:44:00.000Z" }],
    ["시각의 오프셋", { 마감: "2026-10-01T10:00:00.000+09:00" }],
    [
      "기간 객체",
      { 기간: { start: "2026-10-01T09:00", end: "2026-10-03T18:30" }, 기간_end: undefined },
    ],
    ["수식 날짜 객체", { 계산: { start: "2026-10-01", end: null, time_zone: null } }],
    ["롤업 목록의 오프셋", { 묶음: ["2026-10-01T01:00:00.000+00:00"] }],
  ])("예전 모양 — %s", (_label, old) => {
    const written: Record<string, unknown> = { ...freshlyWritten(), ...old };
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete written[key];
    expect(seoulMapper().hasOutdatedDateForm(written, remote)).toBe(true);
  });

  it("YAML 이 날짜로 읽은 예전 시각(Date)도 예전 모양이다", () => {
    const { data } = splitFrontmatter("---\n생성일: 2026-10-04T14:44:00.000Z\n---\n");
    expect(data.생성일).toBeInstanceOf(Date);
    const written = { ...freshlyWritten(), 생성일: data.생성일 };
    expect(seoulMapper().hasOutdatedDateForm(written, remote)).toBe(true);
  });

  it("값이 다르면 고르지 않는다 — 다시 계산된 수식 · 시간대를 바꾼 벽시계 시각은 모양 탓이 아니다", () => {
    const mapper = seoulMapper();
    expect(mapper.hasOutdatedDateForm({ ...freshlyWritten(), 계산: "2026-09-30" }, remote)).toBe(
      false,
    );
    expect(
      mapper.hasOutdatedDateForm({ ...freshlyWritten(), 마감: "2026-10-01T01:00" }, remote),
    ).toBe(false);
    expect(
      mapper.hasOutdatedDateForm(
        { ...freshlyWritten(), 마감: "2026-10-01T11:00:00.000+09:00" },
        remote,
      ),
    ).toBe(false);
  });

  it("빈 날짜는 키가 없어도 null 로 적혀 있어도 같다", () => {
    const written = freshlyWritten();
    delete written.빈날;
    expect(seoulMapper().hasOutdatedDateForm(written, remote)).toBe(false);
  });

  it("날짜 속성이 아니면 보지 않는다 — 글 속성에 적힌 시각", () => {
    const written = { ...freshlyWritten(), 메모: "2026-10-04T23:44" };
    expect(seoulMapper().hasOutdatedDateForm(written, remote)).toBe(false);
  });

  it("`_end` 이름의 속성이 따로 있으면 기간 객체가 지금 모양이다 — 안쪽 시각만 본다", () => {
    const collided = {
      기간: date("2026-10-01T00:00:00.000+00:00", "2026-10-03T09:30:00.000+00:00"),
      기간_end: { type: "rich_text", rich_text: [{ plain_text: "따로" }] },
    };
    const mapper = seoulMapper();
    const now = { 기간: { end: "2026-10-03T18:30", start: "2026-10-01T09:00" }, 기간_end: "따로" };
    expect(mapper.hasOutdatedDateForm(now, collided)).toBe(false);
    const old = {
      기간: { start: "2026-10-01T09:00:00.000+09:00", end: "2026-10-03T18:30:00.000+09:00" },
      기간_end: "따로",
    };
    expect(mapper.hasOutdatedDateForm(old, collided)).toBe(true);
  });
});

describe("ownedKeys — Notion 이 정하는 frontmatter 키 (F-08)", () => {
  it("제목을 뺀 속성 전부와 날짜 값을 낼 수 있는 속성의 `_end` 키", () => {
    expect(
      seoulMapper().ownedKeys({
        이름: { type: "title", title: [] },
        마감: date("2026-10-01"),
        계산: { type: "formula", formula: { type: "number", number: 1 } },
        메모: { type: "rich_text", rich_text: [] },
        묶음: { type: "rollup", rollup: { type: "number", number: 1 } },
        생성: { type: "created_time", created_time: "2026-10-01T00:00:00.000Z" },
      }),
    ).toEqual(["마감", "마감_end", "계산", "계산_end", "메모", "묶음", "묶음_end", "생성"]);
  });
});

describe("시간대 설정 — conversion.timeZone", () => {
  const withZone = (timeZone: string) =>
    ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, token: "ntn_test_fake_token" },
      conversion: { ...DEFAULT_CONFIG.conversion, timeZone },
    });

  it("설정 시간대로 적고 보낸다", () => {
    const config = withZone("America/New_York");
    const mapper = PropertyMapper.fromConfig(config);
    mapper.loadSchema({ 마감: { id: "a", type: "date" } });
    expect(mapper.fromNotionProperties({ 마감: date("2026-10-01T13:00:00.000Z") }).마감).toBe(
      "2026-10-01T09:00",
    );
    expect(mapper.toNotionProperties({ 마감: "2026-10-01T09:00" }, "T").마감).toEqual({
      date: { start: "2026-10-01T09:00:00-04:00", end: null },
    });
  });

  it("IANA 이름이 아니면 설정을 읽지 않고 이유를 말한다", () => {
    expect(() => withZone("KST")).toThrow(/시간대/);
  });
});
