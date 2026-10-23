/**
 * RowSchemaCache — 사람 속성이 있는 DB 를 만나면 사용자 목록을 한 번만 읽어 매퍼에 준다.
 */
import { describe, it, expect, vi } from "vitest";
import { RowSchemaCache } from "../../src/sync/row-schema-cache.js";
import { peopleResolverOf } from "../../src/notion/property-mapper.js";

const PERSON = "35a13b18d38280cf9057e37e6e473e41";
const resolver = { resolve: () => null, resolvePageId: () => null };

describe("RowSchemaCache — 사람 이름", () => {
  it("사람 속성이 있는 DB 에서만 · 한 번만 읽는다", async () => {
    const loadPeople = vi.fn(async () => peopleResolverOf([{ id: PERSON, name: "담당자" }]));
    const cache = new RowSchemaCache(
      async (id) =>
        id.startsWith("with-people")
          ? { 담당: { id: "p", type: "people" } }
          : { 메모: { id: "m", type: "rich_text" } },
      resolver,
      undefined,
      loadPeople,
    );

    await cache.mapperFor("plain");
    expect(loadPeople).not.toHaveBeenCalled();

    const mapper = await cache.mapperFor("with-people");
    await cache.mapperFor("with-people-other");
    expect(loadPeople).toHaveBeenCalledTimes(1);
    expect(mapper.toNotionProperties({ 담당: ["담당자"] }, "T").담당).toEqual({
      people: [{ object: "user", id: PERSON }],
    });
  });

  it("목록을 못 읽으면 이름은 보내지 않고 id 는 보낸다 — 행은 그대로 만든다", async () => {
    const cache = new RowSchemaCache(
      async () => ({ 담당: { id: "p", type: "people" } }),
      resolver,
      undefined,
      async () => {
        throw new Error("권한 없음");
      },
    );

    const mapper = await cache.mapperFor("db");
    expect(mapper.toNotionProperties({ 담당: ["담당자"] }, "T").담당).toBeUndefined();
    expect(mapper.toNotionProperties({ 담당: [PERSON] }, "T").담당).toEqual({
      people: [{ object: "user", id: PERSON }],
    });
  });
});
