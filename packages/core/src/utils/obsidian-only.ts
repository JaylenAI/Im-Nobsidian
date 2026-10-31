/**
 * Obsidian 에서만 쓰는 것 — 기본으로 동기화하지 않는다(`paths.excludeObsidianOnly`, D10).
 *
 * - Canvas(`.canvas`) · Excalidraw(`.excalidraw.md` · `.excalidraw`) 는 JSON 이다. 노트로 올리면 Notion 에 수천 줄의 JSON 이
 *   생기고, 첨부로 올리면 Notion 에서 열 수 없는 파일 블록이 된다. Notion 에 그 그림을 그릴 곳이 없다.
 * - 템플릿 폴더의 노트는 `{{date}}` · `<% tp.date.now() %>` 같은 자리 표시를 품은 틀이다 — Notion 에 올려도 쓸 곳이 없고
 *   Notion 의 페이지 목록만 어지럽힌다. 폴더는 Obsidian 의 설정에서 읽는다(코어 「템플릿」 · Templater).
 *
 * 이미 동기화한 노트를 빼도 Notion 페이지는 지우지 않는다 — 제외한 노트는 「볼트에서 지움」 으로 보지 않는다.
 */
export const OBSIDIAN_ONLY_PATTERNS: readonly string[] = [
  "*.canvas",
  "*.excalidraw.md",
  "*.excalidraw",
];

/** 템플릿 폴더를 적는 Obsidian 설정 — Obsidian 설정 폴더(`.obsidian`) 기준 파일과 그 키. */
export const TEMPLATE_FOLDER_SETTINGS: ReadonlyArray<{
  readonly file: string;
  readonly key: string;
}> = [
  { file: "templates.json", key: "folder" }, // 코어 플러그인 「템플릿」
  { file: "plugins/templater-obsidian/data.json", key: "templates_folder" }, // Templater
];

/**
 * 설정 파일의 글에서 템플릿 폴더(볼트 기준)를 읽는다. 없거나 깨졌거나 비었으면 뺀다 — 폴더를 정하지 않은 템플릿은 볼트
 * 맨 위를 가리키지 않는다(Obsidian 은 고르지 않은 것으로 본다).
 *
 * @param contents `TEMPLATE_FOLDER_SETTINGS` 의 파일 → 글(없으면 null)
 */
export function templateFolders(contents: (file: string) => string | null): string[] {
  const folders = new Set<string>();
  for (const { file, key } of TEMPLATE_FOLDER_SETTINGS) {
    const text = contents(file);
    if (text === null) continue;
    let value: unknown;
    try {
      value = (JSON.parse(text) as Record<string, unknown>)?.[key];
    } catch {
      continue;
    }
    if (typeof value !== "string") continue;
    const folder = value
      .trim()
      .replace(/\\/g, "/")
      .replace(/^(?:\.\/|\/)+/, "")
      .replace(/\/+$/, "")
      .normalize("NFC");
    if (folder !== "") folders.add(folder);
  }
  return [...folders];
}

/**
 * 이 연결 폴더(볼트 맨 위면 `""`)의 제외 패턴 — 템플릿 폴더는 연결 폴더 기준으로 옮긴다. 연결 밖의 템플릿 폴더는 뺀다. 연결
 * 폴더가 템플릿 폴더이거나 그 안이면 템플릿 폴더를 빼지 않는다 — 그 폴더를 일부러 연결한 것이다.
 */
export function obsidianOnlyExcludes(templates: readonly string[], folder: string): string[] {
  const patterns = [...OBSIDIAN_ONLY_PATTERNS];
  for (const template of templates) {
    if (folder === "") patterns.push(template);
    else if (template.startsWith(`${folder}/`)) patterns.push(template.slice(folder.length + 1));
  }
  return patterns;
}
