/**
 * 설정 `paths.include` · `paths.exclude` 와 `.im-nobsidian-ignore` 의 경로 패턴 (이슈 #8).
 *
 * 볼트 경로는 늘 `/` 로 잇는다({@link toVaultPath}). 예전 판정은 세 가지가 틀렸다.
 *   1. Windows 의 `relative()` 가 준 `00 Me\a.md` 를 `/` 로만 견줘 어느 패턴에도 맞지 않았다
 *   2. 포함 패턴을 폴더에도 대어 `00 Me/**\/*.md` 면 폴더 `00 Me` 가 빠지고 안을 걷지 않았다
 *   3. `**\/` 가 폴더 0 단계를 받지 않았고(`a/**\/*.md` ↛ `a/x.md`) 정규식 글자를 이스케이프하지 않았다
 *
 * 규칙
 *   - 글롭 없는 패턴은 그 경로이거나 그 폴더 안이다 — `Private` ↔ `Private/a.md`
 *   - `/` 없는 글롭은 경로 조각 어느 것에나 댄다 — `*.pdf` ↔ `a/b/x.pdf`, `draft-*` ↔ `x/draft-1/a.md`
 *   - `/` 있는 글롭은 볼트 맨 위부터 댄다. `*` · `?` 는 조각 안, `**` 는 조각을 넘는다
 *   - 패턴에 맞는 폴더의 안은 모두 맞는다 — 걷기가 그 폴더에서 멈추는 것과 같다
 *   - 패턴의 `\` 는 `/` 로, 앞의 `./` · `/` 와 끝의 `/` 는 뗀다
 */
export class PathFilter {
  private readonly include: readonly CompiledPattern[];
  private readonly exclude: readonly CompiledPattern[];

  constructor(include: readonly string[], exclude: readonly string[]) {
    this.include = compileAll(include);
    this.exclude = compileAll(exclude);
  }

  /** 동기화하지 않는 노트 · 첨부 — 포함 패턴 어느 것에도 맞지 않거나 제외 패턴에 맞는다. */
  excludesFile(path: string): boolean {
    if (this.include.length > 0 && !this.include.some((p) => matchesWithin(path, p))) return true;
    return this.excludesFolder(path);
  }

  /**
   * 걷지 않을 폴더 — 제외 패턴만 본다. 포함 패턴은 안의 파일이 정한다: `00 Me/**\/*.md` 는 폴더
   * `00 Me` 에 맞지 않지만 그 안의 노트에 맞는다.
   */
  excludesFolder(path: string): boolean {
    return this.exclude.some((p) => matchesWithin(path, p));
  }
}

/** 운영체제 구분자로 이은 상대 경로 → 볼트 경로(`/`). `relative()` 의 결과에 쓴다. */
export function toVaultPath(relativePath: string, separator: string): string {
  return separator === "/" ? relativePath : relativePath.split(separator).join("/");
}

type CompiledPattern =
  | { readonly kind: "all" }
  | { readonly kind: "prefix"; readonly prefix: string }
  | { readonly kind: "segment"; readonly re: RegExp }
  | { readonly kind: "anchored"; readonly re: RegExp };

function compileAll(patterns: readonly string[]): CompiledPattern[] {
  return patterns.flatMap((raw) => {
    const pattern = normalizePattern(raw);
    return pattern === null ? [] : [compile(pattern)];
  });
}

function normalizePattern(raw: string): string | null {
  const pattern = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/|\/)+/, "")
    .replace(/\/+$/, "");
  return pattern === "" ? null : pattern;
}

function compile(pattern: string): CompiledPattern {
  if (pattern === "**" || pattern === "**/*") return { kind: "all" };
  if (!/[*?]/.test(pattern)) return { kind: "prefix", prefix: pattern };
  // `a/**` 는 `a` 의 안 — 패턴에 맞는 폴더의 안은 모두 맞으므로 `a` 와 같다.
  if (pattern.endsWith("/**") && !/[*?]/.test(pattern.slice(0, -3))) {
    return { kind: "prefix", prefix: pattern.slice(0, -3) };
  }
  const re = globToRegExp(pattern);
  return pattern.includes("/") ? { kind: "anchored", re } : { kind: "segment", re };
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      const segmentStart = i === 0 || pattern[i - 1] === "/";
      if (segmentStart && pattern[i + 2] === "/") {
        source += "(?:.*/)?"; // `**/` — 폴더 0 단계 이상
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** 경로 자신이나 그 위 폴더 하나가 패턴에 맞는가. */
function matchesWithin(path: string, pattern: CompiledPattern): boolean {
  switch (pattern.kind) {
    case "all":
      return true;
    case "prefix":
      return path === pattern.prefix || path.startsWith(`${pattern.prefix}/`);
    case "segment":
      return path.split("/").some((segment) => pattern.re.test(segment));
    case "anchored": {
      const segments = path.split("/");
      for (let depth = 1; depth <= segments.length; depth++) {
        if (pattern.re.test(segments.slice(0, depth).join("/"))) return true;
      }
      return false;
    }
  }
}
