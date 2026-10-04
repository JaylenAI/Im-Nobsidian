import { MARKER_BRAND_RE, MARKER_PAYLOAD_CHAR } from "../constants/markers.js";
import { compactNotionId } from "../utils/id.js";
import { databaseTagId } from "../utils/inline-db-refs.js";
import { decodeMarkerTarget } from "./marker-url.js";

/**
 * Notion Markdown API 가 본문 속 자식 페이지를 싣는 태그 — `<page url="…/<32hex>">제목</page>`.
 *
 * pull 은 이 태그를 `[[제목]]` 으로 바꾸고(enhanced-md-converter), push 는 본문을 통째로
 * 바꾸기 전에 이 태그를 제자리에 되돌려 놓는다({@link restoreChildTags}). 두 쪽이 같은
 * 모양을 봐야 하므로 여기 한 곳에만 둔다. 그룹: 1 = url, 2 = 제목.
 */
export const CHILD_PAGE_TAG_RE = /<page url="([^"]*)">([\s\S]*?)<\/page>/g;

/**
 * 본문 속 자식(인라인) DB 태그 —
 * `<database url="…/<32hex>" inline="true" data-source-url="collection://…">제목</database>`.
 * pull 은 이 태그를 `.base` 임베드로 바꾼다. 그룹: 1 = 속성 전체, 2 = 제목.
 */
export const CHILD_DATABASE_TAG_RE = /<database\b([^>]*)>([\s\S]*?)<\/database>/g;

/** 자식 페이지 태그의 url 에서 id 를 꺼낸다 — 호스트는 고정하지 않는다({@link databaseTagId} 와 같은 이유). */
const ID32_RE = /[a-f0-9]{32}/;

/** Notion 이 돌려준 본문에 실린 자식 하나. */
export interface ChildTag {
  readonly kind: "page" | "database";
  /** 하이픈 없는 32자리 hex. */
  readonly id: string;
  /** 태그 안의 제목 그대로(굵게 `**` 가 섞여 있을 수 있다). */
  readonly title: string;
  /** 태그 원문 — 복원은 받은 그대로 다시 싣는다(실측: 받은 태그를 보내면 자식이 그대로 남는다). */
  readonly tag: string;
}

/** 본문에 실린 자식 페이지 · 자식 DB 태그를 나온 순서대로 모은다. 같은 자식은 한 번만. */
export function extractChildTags(markdown: string): ChildTag[] {
  const found: Array<{ at: number; child: ChildTag }> = [];
  for (const m of markdown.matchAll(CHILD_PAGE_TAG_RE)) {
    const id = ID32_RE.exec(m[1] ?? "")?.[0];
    if (id) {
      found.push({ at: m.index ?? 0, child: { kind: "page", id, title: m[2] ?? "", tag: m[0] } });
    }
  }
  for (const m of markdown.matchAll(CHILD_DATABASE_TAG_RE)) {
    const id = databaseTagId(m[1] ?? "");
    if (id) {
      found.push({
        at: m.index ?? 0,
        child: { kind: "database", id, title: m[2] ?? "", tag: m[0] },
      });
    }
  }

  const seen = new Set<string>();
  const children: ChildTag[] = [];
  for (const { child } of found.sort((a, b) => a.at - b.at)) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    children.push(child);
  }
  return children;
}

/**
 * 자식 페이지 · 자식 DB 태그와 빈 블록 말고 본문이 있는가 — Notion 이 돌려준 원문 그대로 본다.
 * push 가 만든 폴더 페이지는 자식만 싣는다. 본문이 생겼으면 누가 Notion 에서 그 페이지에 글을
 * 쓴 것이다(S-17).
 */
export function hasBodyBesidesChildren(markdown: string): boolean {
  return (
    markdown
      .replace(CHILD_PAGE_TAG_RE, "")
      .replace(CHILD_DATABASE_TAG_RE, "")
      .replace(/<empty-block\/>/g, "")
      .trim().length > 0
  );
}

/** {@link restoreChildTags} 가 `.base` 임베드를 DB 와 맞출 때 쓰는 단서. */
export interface ChildTagRestoreOptions {
  /**
   * `.base` 경로가 가리키는 DB id 들(하이픈 유무 무관). 제목은 바뀌거나 비어 있을 수 있어
   * (링크드 뷰는 태그 제목이 비어 온다) id 로 먼저 맞추고, 못 맞추면 제목으로 맞춘다.
   */
  readonly databaseIdsOfBase?: (basePath: string) => readonly string[];
}

/** 자식 태그를 되돌려 놓은 결과. */
export interface ChildTagRestore {
  readonly markdown: string;
  /** 자식을 가리키던 줄을 태그로 바꾼 수(원래 태그가 있던 줄 포함). */
  readonly placed: number;
  /** 가리키는 줄이 없어 본문 끝에 덧붙인 자식. */
  readonly appended: readonly ChildTag[];
}

const FENCE_RE = /^[ \t>]*(`{3,}|~{3,})/;
const LINE_RE = /^([ \t]*(?:>[ \t]*)*)(.*?)[ \t\r]*$/;
/** push 가 해석된 `[[자식]]` 을 바꿔 놓는 멘션 — `<mention-page url="…"/>`. */
const MENTION_LINE_RE =
  /^<mention-(?:page|database)\b[^>]*?\burl="([^"]*)"[^>]*?(?:\/>|>[^<]*<\/mention-(?:page|database)>)$/;
/** 해석되지 않은 채 나가는 `[[대상]]` · `[[대상|별칭]]`. */
const WIKILINK_LINE_RE = /^\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]$/;
/**
 * `.base` 임베드가 나가는 모양 — `> 📎 이름.base %% im-nobsidian:local-file:<경로|별칭> %%`
 * (converter/pre-processors/embed.ts 의 placeholder). 자리표시자는 제 `>` 로 시작하고 앞에는
 * 컨테이너 들여쓰기만 온다 — 일반 인용 안의 임베드는 인용 접두사를 떼고 나가고, 콜아웃 · 토글 안의
 * 임베드는 그 컨테이너의 자식 줄(`\t> 📎 …`)이 된다(같은 파일 isolate, S-28).
 */
const LOCAL_FILE_LINE_RE = new RegExp(
  `^([ \\t]*)>[ \\t]*📎${MARKER_PAYLOAD_CHAR}*?%%\\s*${MARKER_BRAND_RE}:local-file:(${MARKER_PAYLOAD_CHAR}+?)\\s*%%[ \\t]*$`,
  "u",
);
/**
 * `.base` 를 못 만든 인라인 DB 가 pull 뒤에 남는 자리표시 —
 * `**제목** *(Notion DB)*%%im-nobsidian:child-database:id=<32hex>&title=…%%`
 * (enhanced-md-converter 의 convertDatabaseBlocks).
 */
const DB_PLACEHOLDER_LINE_RE = new RegExp(
  `^\\*\\*[^\\n]*?\\*\\*\\s*\\*\\(Notion DB\\)\\*\\s*%%\\s*${MARKER_BRAND_RE}:child-database:id=([a-f0-9]{32})${MARKER_PAYLOAD_CHAR}*?%%$`,
);

const BASE_PATH_RE = /\.base$/i;

/** 제목 비교용 — pull 이 링크 · 별칭을 만들 때 걷어 내는 글자(`**` · `|[]` · 줄바꿈)를 같게 걷는다. */
function titleKey(title: string): string {
  return title
    .replace(/\*\*/g, "")
    .replace(/[|[\]\n]/g, "")
    .trim()
    .toLowerCase();
}

/** `폴더/이름.md#제목` → `이름`. */
function linkTargetName(target: string): string {
  const path = target.split("#")[0]!;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "");
}

/**
 * 본문을 통째로 바꾸기 전에, 받은 자식 태그를 **그 자식을 가리키던 줄** 에 되돌려 놓는다(S-03).
 *
 * Notion 의 `replace_content` 는 새 본문에 없는 자식 페이지 · 자식 DB 를 지운다. 삭제를
 * 허용하지 않고 보내면(`allow_deleting_content: false`) 무엇이 지워질지 나열하며 요청을
 * 통째로 거절하고, 그 자식들을 `<page>` · `<database>` 태그로 본문에 넣으면 자식이 같은
 * id 로 그 자리에 남는다(2026-09-27 실측 — 태그를 옮기면 자식도 옮겨 간다).
 *
 * pull 은 그 태그를 `[[제목]]` 과 `.base` 임베드로 바꿔 두므로, push 본문에서는 자식이
 * 멘션 · 위키링크 · 첨부 자리표시자 줄로 나타난다. 그 줄 **하나만 통째로** 차지한 경우에만
 * 태그로 바꾼다 — 문장 속 링크는 자식이 아니라 링크다. 코드 블록 안은 보지 않는다.
 * 가리키는 줄이 없는 자식은 본문 끝에 둔다 — 자식을 지우는 일은 본문 push 가 하지 않는다.
 */
export function restoreChildTags(
  markdown: string,
  children: readonly ChildTag[],
  options: ChildTagRestoreOptions = {},
): ChildTagRestore {
  if (children.length === 0) return { markdown, placed: 0, appended: [] };

  const pending = new PendingChildren(children);
  const lines = markdown.split("\n");
  let placed = 0;

  for (const [i, line] of linesOutsideFences(lines)) {
    if (pending.size === 0) break;
    // 첨부 자리표시자는 제 `>` 까지가 자리표시자다 — 태그로 바꿀 때 `>` 를 남기지 않는다.
    const placeholder = LOCAL_FILE_LINE_RE.exec(line);
    const [, prefix = "", content = ""] = placeholder ?? LINE_RE.exec(line) ?? [];
    const child = placeholder
      ? takeBaseEmbed(content, pending, options.databaseIdsOfBase)
      : takeLineChild(content, pending);
    if (child) {
      lines[i] = prefix + child.tag;
      placed++;
    }
  }

  const appended = pending.remaining();
  let out = lines.join("\n");
  if (appended.length > 0) {
    out = `${out.replace(/\s+$/, "")}\n\n${appended.map((c) => c.tag).join("\n\n")}\n`;
  }
  return { markdown: out, placed, appended };
}

/** NFM 컨테이너를 여는 줄 · 닫는 줄 — 줄에 컨테이너 태그만 있을 때. 그룹 1 = 종류. */
const CONTAINER_OPEN_RE = /^[ \t]*<(callout|details|columns|column)\b[^>]*>[ \t]*$/;
const CONTAINER_CLOSE_RE = /^[ \t]*<\/(?:callout|details|columns|column)>[ \t]*$/;

/**
 * 본문에 실린 자식 페이지 · DB 의 배치 — 나온 차례대로 `id@감싼 컨테이너`.
 *
 * 받은 본문과 보낼 본문의 배치가 다르면 자식이 자리를 옮긴다(sync/page-body 의 replacePageBody).
 * 컨테이너는 본문에서 몇 번째로 연 것인지까지 적는다 — 같은 종류의 다른 콜아웃으로 옮겨도 옮긴
 * 것이다. 컨테이너 밖에서는 들여쓰기 단(목록 · 토글 제목 아래)까지 본다. 컨테이너 안의 들여쓰기는
 * 보지 않는다 — Notion 이 돌려주는 본문은 토글 자식을 들여쓰고 push 가 보내는 본문은 들여쓰지 않아,
 * 같은 배치도 들여쓰기가 다르다.
 */
export function childLayout(markdown: string): string[] {
  const layout: string[] = [];
  const open: string[] = [];
  let opened = 0;
  for (const [, line] of linesOutsideFences(markdown.split("\n"))) {
    const kind = CONTAINER_OPEN_RE.exec(line)?.[1];
    if (kind) {
      open.push(`${kind}#${++opened}`);
      continue;
    }
    if (CONTAINER_CLOSE_RE.test(line)) {
      open.pop();
      continue;
    }
    const where = open.length > 0 ? open.join("/") : `+${indentLevel(line)}`;
    for (const child of extractChildTags(line)) layout.push(`${child.id}@${where}`);
  }
  return layout;
}

/** 줄머리 들여쓰기 단 — 탭 하나 · 공백 넷이 한 단, 모자란 공백도 한 단으로 친다. */
function indentLevel(line: string): number {
  const lead = /^[ \t]*/.exec(line)![0];
  const width = [...lead].reduce((sum, c) => sum + (c === "\t" ? 4 : 1), 0);
  return Math.ceil(width / 4);
}

/** 코드 블록 밖의 줄과 그 번호 — 펜스 줄 자체도 뺀다. */
function* linesOutsideFences(lines: readonly string[]): Generator<[number, string]> {
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceRun = FENCE_RE.exec(line)?.[1];
    if (fenceRun) {
      if (fence === null) fence = fenceRun;
      else if (fenceRun[0] === fence[0] && fenceRun.length >= fence.length) fence = null;
      continue;
    }
    if (fence === null) yield [i, line];
  }
}

/** 아직 자리를 못 찾은 자식들. 한 자식은 한 줄에만, 먼저 나온 줄에 놓는다. */
class PendingChildren {
  private readonly byId: Map<string, ChildTag>;

  constructor(children: readonly ChildTag[]) {
    this.byId = new Map(children.map((c) => [c.id, c]));
  }

  get size(): number {
    return this.byId.size;
  }

  remaining(): ChildTag[] {
    return [...this.byId.values()];
  }

  takeId(id: string | undefined): ChildTag | undefined {
    const child = id ? this.byId.get(id) : undefined;
    if (child) this.byId.delete(child.id);
    return child;
  }

  takeTitle(kind: ChildTag["kind"], ...names: string[]): ChildTag | undefined {
    const keys = new Set(names.map(titleKey).filter((k) => k !== ""));
    for (const child of this.byId.values()) {
      if (child.kind === kind && keys.has(titleKey(child.title))) return this.takeId(child.id);
    }
    return undefined;
  }
}

/** 줄 하나를 통째로 차지한 멘션 · DB 자리표시 · 위키링크 · 자식 태그가 가리키는 자식. */
function takeLineChild(content: string, pending: PendingChildren): ChildTag | undefined {
  const mention = MENTION_LINE_RE.exec(content);
  if (mention) return pending.takeId(ID32_RE.exec(mention[1]!)?.[0]);

  const dbPlaceholder = DB_PLACEHOLDER_LINE_RE.exec(content);
  if (dbPlaceholder) return pending.takeId(dbPlaceholder[1]);

  const wikilink = WIKILINK_LINE_RE.exec(content);
  if (wikilink) return pending.takeTitle("page", linkTargetName(wikilink[1]!));

  // 이미 태그 그 자체인 줄(사용자가 옮겨 적은 경우) — 받은 태그로 바꿔 둔다.
  if (content.startsWith("<page ") || content.startsWith("<database")) {
    const [tag] = extractChildTags(content);
    if (tag && tag.tag === content) return pending.takeId(tag.id);
  }
  return undefined;
}

/** `.base` 첨부 자리표시자 — 그 `.base` 의 DB id, 아니면 별칭 · 파일 이름이 DB 제목과 같은 자식. */
function takeBaseEmbed(
  encodedTarget: string,
  pending: PendingChildren,
  databaseIdsOfBase: ChildTagRestoreOptions["databaseIdsOfBase"],
): ChildTag | undefined {
  const [path = "", alias = ""] = decodeMarkerTarget(encodedTarget).split("|");
  if (!BASE_PATH_RE.test(path)) return undefined;
  for (const id of databaseIdsOfBase?.(path) ?? []) {
    const child = pending.takeId(compactNotionId(id));
    if (child) return child;
  }
  const stem = path.slice(path.lastIndexOf("/") + 1).replace(BASE_PATH_RE, "");
  return pending.takeTitle("database", alias, stem);
}

/** push 본문의 `.base` 임베드 자리표시자가 가리키는 볼트 경로(별칭 뺌). 같은 경로는 한 번만. */
export function baseEmbedPaths(markdown: string): string[] {
  const paths = new Set<string>();
  for (const line of markdown.split("\n")) {
    const placeholder = LOCAL_FILE_LINE_RE.exec(line);
    if (!placeholder) continue;
    const path = decodeMarkerTarget(placeholder[2]!).split("|")[0]!;
    if (BASE_PATH_RE.test(path)) paths.add(path);
  }
  return [...paths];
}
