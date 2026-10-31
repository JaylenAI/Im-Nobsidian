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

  // P11 — iOS 16.4 앞의 JavaScript 는 lookbehind 를 읽지 못해 main.js 전체가 뜨지 않는다. 디렉터리 검사도 데스크톱
  // 전용이 아닌 플러그인의 lookbehind 를 거절한다. 빌드한 main.js(주석이 없다)를 본다 — 의존성에서 들어와도 잡는다.
  it("main.js 에 정규식 lookbehind 가 없다", () => {
    const bundle = read("../main.js");
    const found = [...bundle.matchAll(/\(\?<[=!]/g)].map((m) =>
      bundle.slice(Math.max(0, m.index - 40), m.index + 40),
    );
    expect(found).toEqual([]);
  });
});
