#!/usr/bin/env node
// 릴리스 게이트 — 태그와 레포가 적은 버전이 모두 같은지 본다. 하나라도 다르면 아무것도 발행하지 않는다.
//
//   node scripts/check-release-version.mjs v0.4.2   # 태그와 대조 (release.yml)
//   node scripts/check-release-version.mjs          # 레포 안에서 서로 같은지만 (ci.yml)
//
// npm 은 package.json 의 버전으로, Obsidian 은 manifest.json 의 버전으로 받는다. 태그만 올리고 한쪽을
// 빠뜨리면 같은 태그에서 다른 버전이 나간다 — 오류 없이.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 버전을 적는 자리 — 버전을 올릴 때 이 파일들을 함께 고친다(RELEASE_PROCESS.md).
 * `packages/obsidian-plugin/manifest.json` 은 빌드가 루트의 것을 옮긴 사본이라 레포에 없다(.gitignore).
 */
export const VERSION_FILES = [
  "package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/obsidian-plugin/package.json",
  "manifest.json",
];

export const RELEASE_NOTES_DIR = "docs/07-release";
export const CHANGELOG = "docs/06-devlog/CHANGELOG.md";

/**
 * @param {string} root 레포 루트
 * @param {string | undefined} tag `vX.Y.Z` — 없으면 레포 안의 일치만 본다
 * @returns {{ version: string | null, errors: string[] }}
 */
export function checkReleaseVersion(root, tag) {
  const errors = [];
  const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

  const found = VERSION_FILES.map((path) => [path, read(path).version]);
  const version = found[0][1];
  for (const [path, v] of found) {
    if (v !== version)
      errors.push(`${path} 의 버전 ${v} 가 ${VERSION_FILES[0]} 의 ${version} 와 다르다`);
  }

  if (tag !== undefined) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) errors.push(`태그 ${tag} 는 vX.Y.Z 모양이 아니다`);
    else if (tag.slice(1) !== version) errors.push(`태그 ${tag} 와 버전 ${version} 가 다르다`);
  }

  const minApp = read("manifest.json").minAppVersion;
  const listed = read("versions.json")[version];
  if (listed !== minApp) {
    errors.push(
      `versions.json["${version}"] (${listed}) 가 manifest minAppVersion (${minApp}) 과 다르다`,
    );
  }

  const notes = `${RELEASE_NOTES_DIR}/RELEASE_NOTES_v${version}.md`;
  if (!existsSync(join(root, notes))) errors.push(`릴리스 노트 ${notes} 가 없다`);

  const changelog = readFileSync(join(root, CHANGELOG), "utf8");
  if (!changelog.includes(`## [${version}]`))
    errors.push(`${CHANGELOG} 에 ## [${version}] 절이 없다`);

  return { version, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const { version, errors } = checkReleaseVersion(root, process.argv[2]);
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log(version);
}
