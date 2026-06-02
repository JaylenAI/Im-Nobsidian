/**
 * rank14 — DB rename 고아 산출물 정리(selectStaleDbArtifacts) 결정론 잠금.
 *
 * Notion DB 제목이 바뀌면 `.base`/`.notion.json` 파일명이 바뀌어 옛 이름 산출물이 같은
 * 폴더에 고아로 잔존한다(pull 멱등 파괴·삭제검증 부활). 본 테스트는 선택 로직이:
 *   (1) 폴더 직속 고아만 정확히 고르고,
 *   (2) 현재 산출물·중첩 DB 산출물·무관 파일을 절대 고르지 않으며,
 *   (3) 입력 순서를 보존(멱등)함
 * 을 toEqual 로 잠근다(부분일치 아님).
 */
import { describe, it, expect } from "vitest";
import { selectStaleDbArtifacts } from "../../src/sync/stale-db-artifacts.js";

function refs(...paths: string[]): Array<{ path: string }> {
  return paths.map((path) => ({ path }));
}

describe("selectStaleDbArtifacts (rank14)", () => {
  const folder = "databases/Tasks";
  const keep = new Set([`${folder}/MyTasks.base`, `${folder}/MyTasks.notion.json`]);

  it("rename 시 옛 이름의 .base·.notion.json 만 고른다(현재 이름은 제외)", () => {
    const files = refs(
      `${folder}/MyTasks.base`, // 현재 — 보존
      `${folder}/MyTasks.notion.json`, // 현재 — 보존
      `${folder}/Tasks.base`, // 옛 이름 — 삭제
      `${folder}/Tasks.notion.json`, // 옛 이름 — 삭제
    );
    expect(selectStaleDbArtifacts(files, folder, keep)).toEqual([
      `${folder}/Tasks.base`,
      `${folder}/Tasks.notion.json`,
    ]);
  });

  it("중첩 DB(하위 폴더)의 산출물은 절대 고르지 않는다", () => {
    const files = refs(
      `${folder}/Tasks.base`, // 직속 고아 — 삭제
      `${folder}/Sub/Sub.base`, // 하위 폴더(중첩 DB) — 보호
      `${folder}/Sub/Sub.notion.json`, // 하위 폴더 — 보호
      `${folder}/Sub/Deep/Deep.base`, // 더 깊은 중첩 — 보호
    );
    expect(selectStaleDbArtifacts(files, folder, keep)).toEqual([`${folder}/Tasks.base`]);
  });

  it("무관 파일(이미지·행 첨부 등)과 다른 폴더 파일은 고르지 않는다", () => {
    const files = refs(
      `${folder}/cover.png`, // .base/.notion.json 아님 — 제외
      `${folder}/Tasks.csv`, // 산출물 아님 — 제외
      `databases/Other/Other.base`, // 다른 DB 폴더 — 제외
      `${folder}/Tasks.base`, // 직속 고아 — 삭제
    );
    expect(selectStaleDbArtifacts(files, folder, keep)).toEqual([`${folder}/Tasks.base`]);
  });

  it("고아가 없으면 빈 배열(멱등 — 2회차 재실행 시 삭제 대상 0)", () => {
    const files = refs(`${folder}/MyTasks.base`, `${folder}/MyTasks.notion.json`);
    expect(selectStaleDbArtifacts(files, folder, keep)).toEqual([]);
  });

  it("접두 충돌 방지 — 'databases/Tasks2/...' 는 'databases/Tasks' 직속이 아니다", () => {
    const files = refs(
      `databases/Tasks2/Tasks2.base`, // 접두가 비슷하지만 다른 폴더 — 제외
      `${folder}/Tasks.base`, // 직속 고아 — 삭제
    );
    expect(selectStaleDbArtifacts(files, folder, keep)).toEqual([`${folder}/Tasks.base`]);
  });

  it("반환은 입력 순서를 보존한다(결정론)", () => {
    const files = refs(
      `${folder}/Zebra.notion.json`,
      `${folder}/Apple.base`,
      `${folder}/Mango.notion.json`,
    );
    expect(selectStaleDbArtifacts(files, folder, keep)).toEqual([
      `${folder}/Zebra.notion.json`,
      `${folder}/Apple.base`,
      `${folder}/Mango.notion.json`,
    ]);
  });
});
