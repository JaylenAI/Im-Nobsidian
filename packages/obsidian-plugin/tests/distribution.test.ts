/**
 * 배포 파일 (U-05) — Obsidian 앱 · BRAT · 커뮤니티 디렉터리는 레포 «루트» 의 manifest.json · versions.json 을
 * 읽고, 릴리스에서 main.js · manifest.json · styles.css 세 파일만 내려받는다(ADR-031 · ADR-032).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf-8");

const SEMVER = /^\d+\.\d+\.\d+$/;

describe("배포 파일", () => {
  it("빌드가 플러그인 폴더에 옮겨 두는 manifest.json 은 루트 manifest.json 과 같다", () => {
    expect(read("../manifest.json")).toBe(read("../../../manifest.json"));
  });

  it("versions.json 은 지금 manifest 버전을 담고, 키와 값이 모두 x.y.z 다", () => {
    const manifest = JSON.parse(read("../../../manifest.json")) as { version: string };
    const versions = JSON.parse(read("../../../versions.json")) as Record<string, string>;

    expect(Object.keys(versions)).toContain(manifest.version);
    expect(Object.entries(versions).filter(([k, v]) => !SEMVER.test(k) || !SEMVER.test(v))).toEqual(
      [],
    );
  });
});
