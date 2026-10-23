import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — 레포 스크립트(.mjs)라 타입이 없다
import * as gate from "../../../scripts/check-release-version.mjs";

const { checkReleaseVersion, VERSION_FILES, RELEASE_NOTES_DIR, CHANGELOG } = gate as {
  checkReleaseVersion: (root: string, tag?: string) => { version: string; errors: string[] };
  VERSION_FILES: string[];
  RELEASE_NOTES_DIR: string;
  CHANGELOG: string;
};

/** 버전이 모두 맞는 레포 하나 — `change` 로 한 자리를 틀리게 만든다. */
function repo(version: string, change: (root: string) => void = () => {}): string {
  const root = mkdtempSync(join(tmpdir(), "release-gate-"));
  const write = (path: string, body: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  for (const path of VERSION_FILES) {
    write(path, JSON.stringify({ version, minAppVersion: "1.12.4" }));
  }
  write("versions.json", JSON.stringify({ [version]: "1.12.4" }));
  write(`${RELEASE_NOTES_DIR}/RELEASE_NOTES_v${version}.md`, "# 노트");
  write(CHANGELOG, `## [${version}] - 2026-10-23`);
  change(root);
  return root;
}

describe("릴리스 게이트 — 태그와 레포의 버전", () => {
  it("모두 같으면 통과", () => {
    expect(checkReleaseVersion(repo("0.4.2"), "v0.4.2")).toEqual({ version: "0.4.2", errors: [] });
  });

  it("태그 없이 부르면 레포 안의 일치만 본다", () => {
    expect(checkReleaseVersion(repo("0.4.2")).errors).toEqual([]);
  });

  it("태그가 버전과 다르면 막는다", () => {
    expect(checkReleaseVersion(repo("0.4.1"), "v0.4.2").errors).toEqual([
      "태그 v0.4.2 와 버전 0.4.1 가 다르다",
    ]);
  });

  it.each(VERSION_FILES.slice(1))("%s 하나만 옛 버전이면 막는다", (path) => {
    const root = repo("0.4.2", (r) =>
      writeFileSync(join(r, path), JSON.stringify({ version: "0.4.1" })),
    );
    expect(checkReleaseVersion(root, "v0.4.2").errors).toContainEqual(
      expect.stringContaining(path),
    );
  });

  it("versions.json · 릴리스 노트 · CHANGELOG 가 빠지면 막는다", () => {
    const root = repo("0.4.2", (r) => {
      writeFileSync(join(r, "versions.json"), "{}");
      writeFileSync(join(r, CHANGELOG), "## [0.4.1]");
    });
    rmSync(join(root, `${RELEASE_NOTES_DIR}/RELEASE_NOTES_v0.4.2.md`));
    const { errors } = checkReleaseVersion(root, "v0.4.2");
    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toMatch(/versions\.json[\s\S]*RELEASE_NOTES[\s\S]*CHANGELOG/);
  });

  it("vX.Y.Z 모양이 아닌 태그는 막는다", () => {
    expect(checkReleaseVersion(repo("0.4.2"), "0.4.2").errors).toEqual([
      "태그 0.4.2 는 vX.Y.Z 모양이 아니다",
    ]);
  });

  // 빌드 산출물(플러그인 폴더의 manifest 사본)을 목록에 넣으면 로컬은 통과하고 CI(깨끗한 체크아웃)만 깨진다.
  it("버전을 적는 자리는 모두 레포가 추적하는 파일이다", () => {
    const tracked = execFileSync("git", ["ls-files", ...VERSION_FILES], {
      cwd: join(import.meta.dirname, "../../.."),
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(tracked.sort()).toEqual([...VERSION_FILES].sort());
  });
});
