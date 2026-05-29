import { describe, it, expect } from "vitest";
import { resolveDbRowPath, type PathOwner } from "../../src/utils/db-row-path.js";

/**
 * 결함11 회귀: 같은 DB 의 동명 페이지가 8 글자 ID prefix 를 공유하면 단일 8 글자
 * 접미사로는 같은 경로로 귀결되어 데이터 손실 + 영구 churn 이 발생했다. 실 E2E 에서
 * 재현된 충돌 쌍(둘 다 "제목 없음", prefix 모두 c6313b18)을 앵커로 고정한다.
 */
describe("resolveDbRowPath (결함11 8자 prefix 충돌 방지)", () => {
  const FOLDER = "DB/루틴추적기";
  const NAME = "제목 없음";
  // 실 E2E 에서 충돌한 두 페이지 — 앞 8 글자(c6313b18)가 동일하다.
  const E7 = "c6313b18-d382-83e7-9fba-81a4a844db5e";
  const D8 = "c6313b18-d382-83d8-a302-812e473fc6e9";

  /** path→owner 맵 기반의 lookup 함수를 만든다. */
  const makeLookup =
    (map: Record<string, string>) =>
    (path: string): PathOwner | null =>
      map[path] ? { notionPageId: map[path]! } : null;

  it("점유자 없으면 자연 경로", () => {
    const path = resolveDbRowPath(FOLDER, NAME, E7, () => null);
    expect(path).toBe(`${FOLDER}/${NAME}.md`);
  });

  it("자연 경로가 자기 자신 소유면 그대로 사용(멱등)", () => {
    const lookup = makeLookup({ [`${FOLDER}/${NAME}.md`]: E7 });
    expect(resolveDbRowPath(FOLDER, NAME, E7, lookup)).toBe(`${FOLDER}/${NAME}.md`);
  });

  it("자연 경로가 다른 페이지 소유면 8 글자 접미사", () => {
    const other = "aaaa1111-2222-3333-4444-555566667777";
    const lookup = makeLookup({ [`${FOLDER}/${NAME}.md`]: other });
    expect(resolveDbRowPath(FOLDER, NAME, E7, lookup)).toBe(`${FOLDER}/${NAME} (c6313b18).md`);
  });

  it("8 글자 접미사까지 다른 페이지 소유면 16 글자로 확장 (핵심 회귀)", () => {
    // E7 이 자연·8글자 경로를 모두 점유한 상태에서 D8 을 배정 → 충돌 회피로 16 글자.
    const other = "aaaa1111-2222-3333-4444-555566667777";
    const lookup = makeLookup({
      [`${FOLDER}/${NAME}.md`]: other,
      [`${FOLDER}/${NAME} (c6313b18).md`]: E7,
    });
    const path = resolveDbRowPath(FOLDER, NAME, D8, lookup);
    expect(path).toBe(`${FOLDER}/${NAME} (c6313b18d38283d8).md`);
    // 절대 E7 의 경로를 재사용하지 않는다(데이터 손실 방지).
    expect(path).not.toBe(`${FOLDER}/${NAME} (c6313b18).md`);
  });

  it("두 동-prefix 페이지가 항상 서로 다른 경로로 수렴(처리 순서 무관)", () => {
    // 순서 A: E7 먼저 → 8글자, D8 나중 → 16글자
    const m1: Record<string, string> = {
      [`${FOLDER}/${NAME}.md`]: "first-page-0000-0000-000000000000",
    };
    const pE7 = resolveDbRowPath(FOLDER, NAME, E7, makeLookup(m1));
    m1[pE7] = E7;
    const pD8 = resolveDbRowPath(FOLDER, NAME, D8, makeLookup(m1));
    expect(pE7).not.toBe(pD8);

    // 순서 B: D8 먼저 → 8글자, E7 나중 → 16글자. 어느 순서든 충돌 0.
    const m2: Record<string, string> = {
      [`${FOLDER}/${NAME}.md`]: "first-page-0000-0000-000000000000",
    };
    const qD8 = resolveDbRowPath(FOLDER, NAME, D8, makeLookup(m2));
    m2[qD8] = D8;
    const qE7 = resolveDbRowPath(FOLDER, NAME, E7, makeLookup(m2));
    expect(qD8).not.toBe(qE7);
  });

  it("16 글자도 충돌하는 극단 케이스는 32 글자(전체 ID)로 수렴", () => {
    // 16 글자까지 동일한 두 ID(매우 비현실적이나 방어). E7 의 앞 16 글자를 공유하는 가짜 점유자.
    const sharing16 = "c6313b18d38283e7-ffff-ffff-ffffffffffff"; // 앞 16 hex 동일
    const lookup = makeLookup({
      [`${FOLDER}/${NAME}.md`]: "other-0000",
      [`${FOLDER}/${NAME} (c6313b18).md`]: "other-1111",
      [`${FOLDER}/${NAME} (c6313b18d38283e7).md`]: sharing16,
    });
    const path = resolveDbRowPath(FOLDER, NAME, E7, lookup);
    expect(path).toBe(`${FOLDER}/${NAME} (c6313b18d38283e79fba81a4a844db5e).md`);
  });

  it("하이픈 유무가 달라도 자기 소유로 인식(멱등)", () => {
    // 저장된 ID 가 하이픈 없는 형식이어도 동일 페이지로 판정한다.
    const lookup = makeLookup({ [`${FOLDER}/${NAME}.md`]: E7.replace(/-/g, "") });
    expect(resolveDbRowPath(FOLDER, NAME, E7, lookup)).toBe(`${FOLDER}/${NAME}.md`);
  });
});
