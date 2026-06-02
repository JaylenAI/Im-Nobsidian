import { describe, it, expect } from "vitest";
import { resolveDbRowPath, selectDbRowFiles, type PathOwner } from "../../src/utils/db-row-path.js";

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

/**
 * rank21 회귀(I9 오포함 차단): DB 폴더 행 선택은 **직속(depth 1)** 만 포함해야 한다.
 * `path.startsWith(prefix)` 단순 매칭은 중첩 child_database·자식 페이지 본문까지 부모 DB 의
 * 행으로 끌어들여 ① 뷰에 남의 카드를 새게 하고 ② push 가 하위 DB 행을 부모로 잘못 민다.
 * `selectStaleDbArtifacts` 와 동일한 "직속만" 규칙을 결정적으로 잠근다.
 */
describe("selectDbRowFiles (rank21 직속 행만 — 중첩 DB 오포함 차단)", () => {
  const FOLDER = "databases/tasks";
  const ref = (path: string) => ({ path });

  it("직속 .md 행만 포함하고 중첩 하위 폴더(child_database·자식 본문)는 제외", () => {
    const files = [
      ref("databases/tasks/Row A.md"), // 직속 — 포함
      ref("databases/tasks/Row B.md"), // 직속 — 포함
      ref("databases/tasks/SubDB/Nested Row.md"), // 중첩 DB 행 — 제외
      ref("databases/tasks/SubDB/Deeper/Leaf.md"), // 더 깊은 중첩 — 제외
    ];
    const rows = selectDbRowFiles(files, FOLDER).map((f) => f.path);
    expect(rows).toEqual(["databases/tasks/Row A.md", "databases/tasks/Row B.md"]);
  });

  it("형제 폴더(prefix 부분일치)는 폴더 경계로 정확히 배제", () => {
    // 'databases/tasks2' 는 'databases/tasks/' prefix 에 걸리면 안 된다(부분 문자열 함정).
    const files = [
      ref("databases/tasks/Mine.md"), // 포함
      ref("databases/tasks2/Theirs.md"), // 형제 DB — 제외
      ref("databases/tasksX.md"), // 형제 파일 — 제외
    ];
    expect(selectDbRowFiles(files, FOLDER).map((f) => f.path)).toEqual(["databases/tasks/Mine.md"]);
  });

  it("폴더 자기 자신 경로·빈 rel 은 행이 아니다(자기포함 방지)", () => {
    // localFolder 와 정확히 같은 경로(rel="")는 행으로 치지 않는다.
    const files = [ref("databases/tasks"), ref("databases/tasks/Real.md")];
    expect(selectDbRowFiles(files, FOLDER).map((f) => f.path)).toEqual(["databases/tasks/Real.md"]);
  });

  it("후행 슬래시 유무에 무관하게 동일 결과(정규화)", () => {
    const files = [ref("databases/tasks/A.md"), ref("databases/tasks/Sub/B.md")];
    const withSlash = selectDbRowFiles(files, "databases/tasks/").map((f) => f.path);
    const withoutSlash = selectDbRowFiles(files, "databases/tasks").map((f) => f.path);
    expect(withSlash).toEqual(["databases/tasks/A.md"]);
    expect(withSlash).toEqual(withoutSlash);
  });

  it("입력 순서를 보존하고 입력 배열을 변형하지 않는다(결정적·부수효과 0)", () => {
    const files = [
      ref("databases/tasks/Z.md"),
      ref("databases/tasks/Sub/x.md"),
      ref("databases/tasks/A.md"),
    ];
    const snapshot = files.map((f) => f.path);
    const rows = selectDbRowFiles(files, FOLDER).map((f) => f.path);
    // 정렬하지 않음 — 입력 순서 그대로(Z 가 A 보다 앞).
    expect(rows).toEqual(["databases/tasks/Z.md", "databases/tasks/A.md"]);
    // 원본 불변.
    expect(files.map((f) => f.path)).toEqual(snapshot);
  });
});
