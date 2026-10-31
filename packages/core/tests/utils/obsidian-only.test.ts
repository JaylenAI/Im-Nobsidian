import { describe, it, expect } from "vitest";
import {
  OBSIDIAN_ONLY_PATTERNS,
  obsidianOnlyExcludes,
  templateFolders,
} from "../../src/utils/obsidian-only.js";
import { PathFilter } from "../../src/utils/path-filter.js";

describe("Obsidian 에서만 쓰는 것 (D10)", () => {
  const settings = (files: Record<string, string>) => (file: string) => files[file] ?? null;

  it("코어 템플릿 · Templater 설정의 폴더를 읽는다 — 모양을 고르고 같은 폴더는 하나로", () => {
    expect(
      templateFolders(
        settings({
          "templates.json": '{"folder":"/Templates/"}',
          "plugins/templater-obsidian/data.json": '{"templates_folder":"Templates"}',
        }),
      ),
    ).toEqual(["Templates"]);
    expect(
      templateFolders(
        settings({ "plugins/templater-obsidian/data.json": '{"templates_folder":"a\\\\틀"}' }),
      ),
    ).toEqual(["a/틀"]);
    expect(
      templateFolders(settings({ "templates.json": `{"folder":"${"틀".normalize("NFD")}"}` })),
    ).toEqual(["틀"]);
  });

  it("없거나 · 깨졌거나 · 비었거나 · 글자가 아니면 뺀다 — 볼트 맨 위를 빼지 않는다", () => {
    expect(templateFolders(settings({}))).toEqual([]);
    for (const text of ["{", '{"folder":""}', '{"folder":"/"}', '{"folder":3}', "null", "[]"]) {
      expect(templateFolders(settings({ "templates.json": text }))).toEqual([]);
    }
  });

  it("연결 폴더 기준으로 옮긴다 — 밖은 빼고, 템플릿 폴더 자신이나 그 안을 연결했으면 빼지 않는다", () => {
    const templates = ["Templates", "Work/틀"];
    expect(obsidianOnlyExcludes(templates, "")).toEqual([...OBSIDIAN_ONLY_PATTERNS, ...templates]);
    expect(obsidianOnlyExcludes(templates, "Work")).toEqual([...OBSIDIAN_ONLY_PATTERNS, "틀"]);
    expect(obsidianOnlyExcludes(templates, "Work/틀")).toEqual([...OBSIDIAN_ONLY_PATTERNS]);
    expect(obsidianOnlyExcludes(templates, "Templates/x")).toEqual([...OBSIDIAN_ONLY_PATTERNS]);
    expect(obsidianOnlyExcludes(templates, "Workshop")).toEqual([...OBSIDIAN_ONLY_PATTERNS]);
  });

  it("패턴은 어느 깊이의 Canvas · Excalidraw 에도 맞고 · 비슷한 이름은 남긴다", () => {
    const filter = new PathFilter([], obsidianOnlyExcludes(["Templates"], ""));
    for (const path of [
      "a.canvas",
      "x/y/b.canvas",
      "d.excalidraw.md",
      "x/d.excalidraw",
      "Templates/t.md",
    ]) {
      expect(filter.excludesFile(path)).toBe(true);
    }
    for (const path of ["canvas.md", "excalidraw.md", "x/a.excalidraw.png", "Templates2/t.md"]) {
      expect(filter.excludesFile(path)).toBe(false);
    }
  });
});
