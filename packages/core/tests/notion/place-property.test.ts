/**
 * 장소(place) 속성 — 지도 보기가 쓰는 위치. 2026-10-23 실측(API 2025-09-03): DB 를 만들 때 `{ place: {} }` 로
 * 만들 수 있고, 값은 `{ lat, lon, name, address, aws_place_id, google_place_id }` 로 오며 같은 꼴로 쓸 수 있다.
 * API 는 이름 · 주소로 좌표를 찾지 않는다 — 쓸 때 lat · lon 이 있어야 한다.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PropertyMapper } from "../../src/notion/property-mapper.js";
import { diffRowProperties } from "../../src/sync/row-properties.js";

const SEOUL = {
  lat: 37.5665,
  lon: 126.978,
  name: "서울시청",
  address: "서울 중구 세종대로 110",
  aws_place_id: null,
  google_place_id: null,
};

describe("장소 속성", () => {
  let mapper: PropertyMapper;
  beforeEach(() => {
    mapper = new PropertyMapper();
    mapper.loadSchema({ 장소: { id: "p", type: "place" } });
  });

  it("받으면 좌표와 이름 · 주소를 적고 빈 칸은 뺀다", () => {
    const props = mapper.fromNotionProperties({
      장소: { id: "p", type: "place", place: SEOUL },
    });
    expect(props.장소).toEqual({
      lat: 37.5665,
      lon: 126.978,
      name: "서울시청",
      address: "서울 중구 세종대로 110",
    });
  });

  it("값이 없으면 null", () => {
    const props = mapper.fromNotionProperties({ 장소: { id: "p", type: "place", place: null } });
    expect(props.장소).toBeNull();
  });

  it("보내면 같은 꼴 — 이름만 있는 장소도", () => {
    const { properties, skipped } = mapper.toNotionPropertyChanges(
      diffRowProperties(null, { 장소: { lat: 37.5, lon: 127, name: "어딘가" } }),
      null,
    );
    expect(skipped).toEqual([]);
    expect(properties.장소).toEqual({ place: { lat: 37.5, lon: 127, name: "어딘가" } });
  });

  it("좌표가 없거나 범위를 벗어나면 보내지 않는다 — API 가 요청 전체를 거부한다", () => {
    const { properties, skipped } = mapper.toNotionPropertyChanges(
      diffRowProperties(null, { 장소: { name: "주소만", address: "서울" } }),
      null,
    );
    expect(properties).toEqual({});
    expect(skipped).toEqual(["장소"]);
    expect(
      mapper.toNotionPropertyChanges(diffRowProperties(null, { 장소: { lat: 91, lon: 0 } }), null)
        .skipped,
    ).toEqual(["장소"]);
  });

  it("비우면 null 로 지운다", () => {
    const { properties } = mapper.toNotionPropertyChanges(
      diffRowProperties({ 장소: { lat: 1, lon: 2 } }, { 장소: null }),
      null,
    );
    expect(properties.장소).toEqual({ place: null });
  });

  it("받은 그대로면 바뀐 것이 없다", () => {
    const pulled = mapper.fromNotionProperties({ 장소: { id: "p", type: "place", place: SEOUL } });
    expect(diffRowProperties(pulled, { ...pulled }).changed).toEqual({});
  });
});
