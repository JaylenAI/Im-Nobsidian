import { mapOutsideCodeFences, mapOutsideInlineCode } from "./md-regions.js";

/**
 * 옮기거나 이름을 바꾼 파일을 가리키던 링크를 새 경로로 고친다 — 위키링크 · 임베드 · 마크다운 링크.
 *
 * 동기화가 볼트의 파일을 옮기면(Notion 에서 옮긴 페이지 · 바꾼 제목) Obsidian 의 「링크 자동 갱신」 이 돌지 않는다 —
 * 플러그인도 `vault.rename` 으로 옮기고, CLI 는 Obsidian 밖이다. 그대로 두면 다른 노트의 `[[옛 이름]]` 이 끊긴다.
 *
 * 링크가 가리키는 파일은 Obsidian 처럼 푼다 — `[[이름]]` 은 볼트에서 그 이름인 파일(같은 이름이 여럿이면 링크를 쓴
 * 노트의 폴더에 있는 것, 그것도 없으면 모르는 것으로 보고 두지 않는다), `[[폴더/이름]]` 은 볼트 경로(아니면 그 경로로
 * 끝나는 유일한 파일), `./` · `../` 로 시작하면 노트 기준. 확장자가 없으면 `.md` 다. 고친 링크는 원래 꼴을 따른다 — 이름
 * 꼴은 새 이름(볼트에 같은 이름이 또 있으면 경로), 경로 꼴은 새 경로, 상대 꼴은 새 상대 경로. `#제목` · `|별칭` 은 둔다.
 * 코드 펜스 · 인라인 코드 안은 고치지 않는다 — Obsidian 도 거기의 링크는 링크로 보지 않는다.
 */
export interface LinkRewriteContext {
  /** 바꾸기 «전» 볼트의 파일 경로 전부 — 링크가 어디를 가리켰는지 이것으로 푼다. */
  readonly before: ReadonlySet<string>;
  /** 바꾼 «뒤» 볼트의 파일 경로 전부 — 새 이름 링크가 한 곳만 가리키는지 이것으로 본다. */
  readonly after: ReadonlySet<string>;
  /** 옛 경로 → 새 경로 — 파일 하나씩(폴더는 안의 파일로 편다). */
  readonly renames: ReadonlyMap<string, string>;
}

/** 링크를 쓴 노트의 옛 경로와 지금 경로 — 노트 자신이 옮겼으면 상대 링크를 새 자리 기준으로 다시 적는다. */
export interface LinkSource {
  readonly from: string;
  readonly to: string;
}

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
/** `[글](대상)` · `[글](<대상>)` · 뒤의 `"제목"`. 대상에 공백 · 괄호가 없거나 `<>` 로 감쌌다. */
const MARKDOWN_LINK = /(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s<>]+)((?:\s+"[^"\n]*")?\))/g;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function rewriteLinks(
  content: string,
  source: LinkSource,
  context: LinkRewriteContext,
): string {
  if (!content.includes("[[") && !content.includes("](")) return content;
  return mapOutsideCodeFences(content, (fenceFree) =>
    mapOutsideInlineCode(fenceFree, (text) =>
      text
        .replace(WIKILINK, (whole, bang: string, inner: string) => {
          const [target, rest] = splitWikiTarget(inner);
          const next = rewriteTarget(target, source, context, "wiki");
          return next === null ? whole : `${bang}[[${next}${rest}]]`;
        })
        .replace(MARKDOWN_LINK, (whole, head: string, raw: string, tail: string) => {
          const bracketed = raw.startsWith("<");
          const url = bracketed ? raw.slice(1, -1) : raw;
          if (URL_SCHEME.test(url) || url.startsWith("#")) return whole;
          const hash = url.indexOf("#");
          const target = hash === -1 ? url : url.slice(0, hash);
          let decoded: string;
          try {
            decoded = decodeURI(target);
          } catch {
            return whole;
          }
          const next = rewriteTarget(decoded, source, context, "markdown");
          if (next === null) return whole;
          const encoded = bracketed ? next : encodeMarkdownTarget(next, target);
          const fragment = hash === -1 ? "" : url.slice(hash);
          return `${head}${bracketed ? `<${encoded}${fragment}>` : `${encoded}${fragment}`}${tail}`;
        }),
    ),
  );
}

/** `대상#제목|별칭` → [`대상`, `#제목|별칭`]. 표 안의 `\|` 도 별칭 구분이다. */
function splitWikiTarget(inner: string): [string, string] {
  const cut = inner.search(/\\?\||#/);
  return cut === -1 ? [inner, ""] : [inner.slice(0, cut), inner.slice(cut)];
}

type LinkStyle = "name" | "path" | "relative";

/** 링크 대상의 새 글 — 고칠 것이 없으면 null. */
function rewriteTarget(
  target: string,
  source: LinkSource,
  context: LinkRewriteContext,
  kind: "wiki" | "markdown",
): string | null {
  const linkpath = target.trim();
  if (linkpath === "") return null;
  const style: LinkStyle = /^\.\.?\//.test(linkpath)
    ? "relative"
    : linkpath.includes("/")
      ? "path"
      : "name";
  // 마크다운 링크의 `a/b.md` 는 노트 기준 상대 경로이기도 하다 — 노트 기준을 먼저 본다.
  const resolved =
    style === "path" && kind === "markdown"
      ? (resolveRelative(linkpath, source.from, context.before) ??
        resolveLinkpath(linkpath, source.from, context.before))
      : resolveLinkpath(linkpath, source.from, context.before);
  if (resolved === null) return null;
  const moved = context.renames.get(resolved.path);
  const sourceMoved = source.from !== source.to;
  if (moved === undefined && !(sourceMoved && resolved.relative)) return null;
  const destination = moved ?? resolved.path;
  const keepExtension = resolved.explicitExtension || !destination.endsWith(".md");
  const shown = keepExtension ? destination : destination.slice(0, -".md".length);

  let next: string;
  if (resolved.relative) {
    next = relativePath(folderOf(source.to), shown);
    // `./` 없이 적은 상대 링크(`a/b.md`)는 그대로 `./` 없이
    if (!linkpath.startsWith("./") && next.startsWith("./")) next = next.slice(2);
  } else if (style === "name") {
    const name = baseName(shown);
    next = uniqueName(baseName(destination), context.after) ? name : shown;
  } else {
    next = shown;
  }
  return next === linkpath ? null : next;
}

interface ResolvedLink {
  readonly path: string;
  /** 링크가 확장자를 적었나 — `[[a.md]]` · `[x](a.md)`. 고친 링크도 적는다. */
  readonly explicitExtension: boolean;
  /** 노트 기준 상대 경로로 풀었나. */
  readonly relative: boolean;
}

function resolveLinkpath(
  linkpath: string,
  sourcePath: string,
  files: ReadonlySet<string>,
): ResolvedLink | null {
  if (/^\.\.?\//.test(linkpath)) return resolveRelative(linkpath, sourcePath, files);
  const clean = linkpath.replace(/^\/+/, "");
  const candidates = withExtension(clean);
  for (const candidate of candidates) {
    if (files.has(candidate)) return found(candidate, linkpath);
  }
  // 이름 꼴 · 경로로 끝나는 꼴 — 그 이름으로 끝나는 파일이 하나면 그것, 여럿이면 노트 폴더의 것.
  for (const candidate of candidates) {
    const suffix = `/${candidate}`;
    const matches = byName(files, baseName(candidate)).filter((file) => file.endsWith(suffix));
    if (matches.length === 1) return found(matches[0]!, linkpath);
    if (matches.length > 1) {
      const local = `${folderPrefix(folderOf(sourcePath))}${candidate}`;
      return matches.includes(local) ? found(local, linkpath) : null;
    }
  }
  return null;
}

function resolveRelative(
  linkpath: string,
  sourcePath: string,
  files: ReadonlySet<string>,
): ResolvedLink | null {
  const joined = normalizeSegments(`${folderPrefix(folderOf(sourcePath))}${linkpath}`);
  if (joined === null) return null;
  for (const candidate of withExtension(joined)) {
    if (files.has(candidate)) return { ...found(candidate, linkpath), relative: true };
  }
  return null;
}

function found(path: string, linkpath: string): ResolvedLink {
  return { path, explicitExtension: hasExtension(linkpath), relative: false };
}

/** 링크 대상으로 볼 경로들 — 적은 그대로, 확장자가 없으면 `.md` 를 붙인 것. */
function withExtension(linkpath: string): string[] {
  return hasExtension(linkpath) ? [linkpath, `${linkpath}.md`] : [`${linkpath}.md`, linkpath];
}

function hasExtension(linkpath: string): boolean {
  return /\.[^./]+$/.test(baseName(linkpath));
}

/** 볼트에 이 이름(확장자 포함)인 파일이 하나뿐인가. */
function uniqueName(name: string, files: ReadonlySet<string>): boolean {
  return byName(files, name).length <= 1;
}

/** 이름(확장자 포함) → 그 이름인 파일들. 노트마다 · 링크마다 볼트 전체를 훑지 않도록 목록마다 한 번 만든다. */
const nameIndexes = new WeakMap<ReadonlySet<string>, Map<string, string[]>>();

function byName(files: ReadonlySet<string>, name: string): string[] {
  let index = nameIndexes.get(files);
  if (!index) {
    index = new Map();
    for (const file of files) {
      const key = baseName(file);
      const list = index.get(key);
      if (list) list.push(file);
      else index.set(key, [file]);
    }
    nameIndexes.set(files, index);
  }
  return index.get(name) ?? [];
}

/** `a/./b/../c` → `a/c`. 볼트 밖(`../` 가 넘침)이면 null. */
function normalizeSegments(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
}

/** 폴더 `from` 에서 `to` 로 가는 상대 경로 — 같은 폴더면 `./` 없이 이름만. */
function relativePath(from: string, to: string): string {
  const fromParts = from === "" ? [] : from.split("/");
  const toParts = to.split("/");
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const up = fromParts.length - common;
  const rest = toParts.slice(common).join("/");
  return up === 0 ? `./${rest}` : `${"../".repeat(up)}${rest}`;
}

/** 새 대상을 원래 링크처럼 적는다 — 원래 `%20` 으로 적었거나 공백이 생기면 공백을 `%20` 으로. */
function encodeMarkdownTarget(next: string, original: string): string {
  return original.includes("%") || next.includes(" ") ? next.replace(/ /g, "%20") : next;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function folderPrefix(folder: string): string {
  return folder === "" ? "" : `${folder}/`;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
