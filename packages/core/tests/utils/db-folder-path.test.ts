import { describe, it, expect } from "vitest";
import {
  resolveDbFolderPath,
  repairDbFolderCollisions,
  isDirectDbRowPath,
  type DbFolderConfig,
} from "../../src/utils/db-folder-path.js";

const ID_A = "fe513b18-d382-825a-860a-01d2f9fa0001";
const ID_B = "0db13b18-d382-825a-860a-01d2f9fa0002";

describe("resolveDbFolderPath (F24 동명 형제 DB 폴더 분리)", () => {
  it("빈 폴더는 그대로 사용한다", () => {
    expect(resolveDbFolderPath("템플릿/핵심목표", ID_A, () => null)).toBe("템플릿/핵심목표");
  });

  it("자기 소유 폴더는 그대로 사용한다(멱등)", () => {
    const owner = (f: string) => (f === "템플릿/핵심목표" ? ID_A : null);
    expect(resolveDbFolderPath("템플릿/핵심목표", ID_A, owner)).toBe("템플릿/핵심목표");
  });

  it("하이픈 유무가 달라도 같은 ID 면 자기 소유로 본다", () => {
    const owner = (f: string) => (f === "a/b" ? ID_A.replace(/-/g, "") : null);
    expect(resolveDbFolderPath("a/b", ID_A, owner)).toBe("a/b");
  });

  it("다른 DB 가 점유한 폴더면 id 8글자 접미사로 분리한다", () => {
    const owner = (f: string) => (f === "템플릿/핵심목표" ? ID_A : null);
    expect(resolveDbFolderPath("템플릿/핵심목표", ID_B, owner)).toBe("템플릿/핵심목표 (0db13b18)");
  });

  it("8글자 접미사까지 점유됐으면 16→32 로 넓힌다", () => {
    const raw = ID_B.replace(/-/g, "");
    const taken = new Map<string, string>([
      ["d/n", ID_A],
      [`d/n (${raw.slice(0, 8)})`, ID_A],
      [`d/n (${raw.slice(0, 16)})`, ID_A],
    ]);
    expect(resolveDbFolderPath("d/n", ID_B, (f) => taken.get(f) ?? null)).toBe(
      `d/n (${raw.slice(0, 32)})`,
    );
  });
});

describe("repairDbFolderCollisions", () => {
  it("충돌 쌍의 두 번째 항목만 재배치하고 첫 항목은 원 폴더를 유지한다", () => {
    const configs: DbFolderConfig[] = [
      { databaseId: ID_A, localFolder: "만다라트/핵심목표" },
      { databaseId: ID_B, localFolder: "만다라트/핵심목표" },
    ];
    expect(repairDbFolderCollisions(configs)).toBe(1);
    expect(configs[0]!.localFolder).toBe("만다라트/핵심목표");
    expect(configs[1]!.localFolder).toBe("만다라트/핵심목표 (0db13b18)");
  });

  it("수리 결과는 멱등이다(재실행 시 0건)", () => {
    const configs: DbFolderConfig[] = [
      { databaseId: ID_A, localFolder: "만다라트/핵심목표" },
      { databaseId: ID_B, localFolder: "만다라트/핵심목표" },
    ];
    repairDbFolderCollisions(configs);
    expect(repairDbFolderCollisions(configs)).toBe(0);
  });

  it("충돌 없는 목록은 그대로 둔다", () => {
    const configs: DbFolderConfig[] = [
      { databaseId: ID_A, localFolder: "a/x" },
      { databaseId: ID_B, localFolder: "a/y" },
    ];
    expect(repairDbFolderCollisions(configs)).toBe(0);
    expect(configs.map((c) => c.localFolder)).toEqual(["a/x", "a/y"]);
  });

  it("사용자 설정 DB 폴더(takenFolders)는 선점되어 발견 DB 가 밀려난다", () => {
    const configs: DbFolderConfig[] = [{ databaseId: ID_B, localFolder: "databases/tasks" }];
    const taken = new Map([["databases/tasks", ID_A]]);
    expect(repairDbFolderCollisions(configs, taken)).toBe(1);
    expect(configs[0]!.localFolder).toBe("databases/tasks (0db13b18)");
  });
});

describe("isDirectDbRowPath", () => {
  it("직속 행 파일이면 true", () => {
    expect(isDirectDbRowPath("a/db", "a/db/row.md")).toBe(true);
  });

  it("중첩 하위 폴더 파일이면 false", () => {
    expect(isDirectDbRowPath("a/db", "a/db/sub/row.md")).toBe(false);
  });

  it("다른 폴더(옛 공유 폴더) 파일이면 false — 재배치 판정", () => {
    expect(isDirectDbRowPath("a/db (0db13b18)", "a/db/row.md")).toBe(false);
  });

  it("형제 폴더 prefix 오매칭이 없다", () => {
    expect(isDirectDbRowPath("a/db", "a/db2/row.md")).toBe(false);
  });
});
