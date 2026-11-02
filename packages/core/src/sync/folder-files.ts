/**
 * 폴더 첨부 — 노트에 붙이지 않고 폴더에 그냥 둔 파일(`proj/data.csv`). push 는 그 폴더의 Notion 페이지(폴더 페이지)에 파일
 * 블록으로 올리고, pull 은 같은 폴더에 같은 이름으로 받는다(ADR-054).
 *
 * 예전에는 받는 쪽이 폴더 페이지의 파일 블록을 «본문» 으로 보고 폴더 노트(`proj/proj.md`)를 새로 쓴 뒤 파일을 받은 그림
 * 폴더에 사본으로 받았다 — 올린 볼트도 다시 받으면 제 파일의 사본이 생겼다(2026-11-02 실측).
 */
import { CHILD_DATABASE_TAG_RE, CHILD_PAGE_TAG_RE } from "../converter/child-tags.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import { compactNotionId, normalizeNotionId } from "../utils/id.js";
import { isDatabaseMode } from "./parent-mode.js";
import { notionFileIdOf } from "../utils/notion-file-url.js";
import { notionMediaSpans, uploadedFileNameFromUrl } from "./image-handler.js";
import { recallUploadedMedia } from "./uploaded-media.js";

/** 폴더 페이지에 실린 폴더 첨부 하나. */
export interface FolderFileRef {
  readonly url: string;
  /** 올린 파일 이름 — Notion 이 주소 끝에 싣는다. 받을 때 이 이름으로 쓴다. */
  readonly name: string;
}

/** Notion 이 캡션에 넣는 마크다운 이스케이프를 푼다 — `data\_v2.csv` → `data_v2.csv`. */
function unescapeCaption(caption: string): string {
  return caption.replace(/\\([\\`*_{}[\]()#+\-.!|~<>$&])/g, "$1").trim();
}

/**
 * 폴더 페이지의 본문(Markdown API 원문)이 자식 페이지 · 자식 DB · 빈 블록과 Notion 에 올린 파일뿐이면 그 파일들 — 아니면
 * null(글이 있으면 폴더 노트다).
 *
 * @param namedOnly 캡션이 파일 이름(또는 표시를 단 이름 — {@link folderFileCaption})인 파일만 폴더 첨부로 본다. 자식 페이지가 없는 페이지는 PDF 하나만 붙인 보통
 *   노트일 수도 있어 push 가 남긴 표시(캡션 = 이름)로 가른다. 자식이 있는 페이지는 폴더라 캡션을 보지 않는다 — 이 표시
 *   이전에 올린 폴더 첨부도 받는다.
 */
export function folderFilesOf(markdown: string, namedOnly: boolean): FolderFileRef[] | null {
  let rest = markdown
    .replace(CHILD_PAGE_TAG_RE, "")
    .replace(CHILD_DATABASE_TAG_RE, "")
    .replace(/<empty-block\/>/g, "");
  const files: FolderFileRef[] = [];
  for (const span of notionMediaSpans(rest)) {
    // 내부 참조(`file://`)는 받을 수 없다 — 그런 페이지는 예전처럼 노트로 받는다.
    if (!/^https?:\/\//.test(span.url)) return null;
    const name = uploadedFileNameFromUrl(span.url);
    if (!name) return null;
    if (namedOnly && unescapeCaption(span.label) !== name && !isMarkedCaption(span.label, name)) {
      return null;
    }
    rest = rest.replace(span.full, "");
    files.push({ url: span.url, name });
  }
  return files.length > 0 && rest.trim() === "" ? files : null;
}

/**
 * 폴더 첨부의 캡션 앞 표시 — `📁 data.csv`. 노트 페이지 끝에 붙인 폴더 첨부(ADR-056)를 그 노트가 임베드한 파일과 가른다.
 * v0.3 의 push 는 노트 임베드의 캡션에 임베드 대상(`data.csv`)을 그대로 실어, 캡션 = 이름만으로는 가를 수 없다.
 */
export const FOLDER_FILE_MARK = "📁";

/** 폴더 첨부를 올릴 때 다는 캡션. */
export function folderFileCaption(name: string): string {
  return `${FOLDER_FILE_MARK} ${name}`;
}

/** 표시를 단 폴더 첨부 캡션인가 — 이스케이프는 풀어서 견준다. */
function isMarkedCaption(label: string, name: string): boolean {
  return unescapeCaption(label) === folderFileCaption(name);
}

/** 블록 API 로 읽은 블록의 Notion 에 올린 파일 — 주소 · 캡션. 올린 파일 블록이 아니면 null. */
export function uploadedFileOfBlock(block: {
  readonly type: string;
}): { readonly url: string; readonly caption: string } | null {
  const media = (block as unknown as Record<string, unknown>)[block.type] as
    | { type?: string; file?: { url?: string }; caption?: ReadonlyArray<{ plain_text?: string }> }
    | undefined;
  const url = media?.type === "file" ? media.file?.url : undefined;
  if (!url) return null;
  return { url, caption: (media?.caption ?? []).map((part) => part.plain_text ?? "").join("") };
}

/**
 * 블록이 이 페이지의 폴더 첨부인가 — 적어 둔 Notion 파일 id(`knownIds`)이거나 표시를 단 캡션({@link folderFileCaption}).
 * {@link folderFilesInNote} 의 블록 판.
 */
export function isFolderFileBlock(
  block: { readonly type: string },
  knownIds: ReadonlySet<string>,
): boolean {
  const file = uploadedFileOfBlock(block);
  if (!file) return false;
  const name = uploadedFileNameFromUrl(file.url);
  const fileId = notionFileIdOf(file.url);
  return (
    (fileId !== null && knownIds.has(fileId)) ||
    (name !== null && file.caption === folderFileCaption(name))
  );
}

/** 노트 페이지의 폴더 첨부({@link folderFilesInNote}) — 떼어 낸 본문과 그 파일들. */
export interface NoteFolderFiles {
  /** 폴더 첨부 줄을 뺀 본문 — 노트로 받는다. */
  readonly markdown: string;
  readonly files: readonly FolderFileRef[];
  /** 그 파일들의 원문 줄 — 본문을 바꿀 때 그대로 되실으면 Notion 이 그 블록을 둔다. */
  readonly lines: readonly string[];
}

/** 코드 펜스 줄 — 그 안의 줄은 글이다. 토글 · 목록 안의 펜스는 들여 쓴다. */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * 노트 페이지의 폴더 첨부 — 폴더 노트가 있는 폴더(`X/X.md`)와 노트 이름의 폴더(`X.md` 옆 `X/`)의 파일은 그 노트의 페이지
 * 끝에 붙는다(ADR-056). 줄 하나가 통째로 파일 하나이고, 표시({@link FOLDER_FILE_MARK})를 단 캡션이거나 이 페이지의
 * 폴더 첨부로 적어 둔 파일(`knownIds` — 표시 이전에 폴더 페이지에 올린 것이 그 페이지가 폴더 노트가 되어 남았다)이면 뗀다.
 * 끝자리만 보지 않는다 — Notion 에서 페이지 맨 아래에 글을 쓰면 그 글이 파일 뒤에 붙는다. 들여 쓴 줄(Notion 에서 토글 · 콜아웃
 * 안으로 옮긴 블록)도 뗀다 — 예전에는 노트의 임베드로 받아 받은 그림 폴더에 사본이 생겼다. 둘 다 아니면(캡션 = 이름인 v0.3 의
 * 노트 임베드 등) 노트의 것이다. 코드 펜스 안은 보지 않는다. `lines` 는 들여쓰기를 뺀 줄이다 — push 가 페이지 끝에 되싣는다.
 *
 * @param exclude 폴더 첨부여도 노트의 것으로 볼 파일 — 로컬 노트가 임베드한 이름 등
 * @returns 폴더 첨부가 없으면 null
 */
export function folderFilesInNote(
  markdown: string,
  options: {
    readonly knownIds?: ReadonlySet<string>;
    readonly exclude?: (file: FolderFileRef) => boolean;
  } = {},
): NoteFolderFiles | null {
  const all = markdown.split("\n");
  const drop = new Set<number>();
  const files: FolderFileRef[] = [];
  const lines: string[] = [];
  let fence: string | null = null;
  all.forEach((line, i) => {
    const opener = FENCE_RE.exec(line)?.[1];
    if (opener !== undefined && (fence === null || opener.startsWith(fence))) {
      fence = fence === null ? opener : null;
      return;
    }
    if (fence !== null) return;
    const full = line.trim();
    const [span, ...more] = notionMediaSpans(full);
    if (!span || more.length > 0 || span.full !== full || !/^https?:\/\//.test(span.url)) return;
    const name = uploadedFileNameFromUrl(span.url);
    if (!name) return;
    const fileId = notionFileIdOf(span.url);
    const marked =
      isMarkedCaption(span.label, name) ||
      (fileId !== null && options.knownIds?.has(fileId) === true);
    const file = { url: span.url, name };
    if (!marked || options.exclude?.(file)) return;
    drop.add(i);
    files.push(file);
    lines.push(full);
  });
  if (files.length === 0) return null;
  return {
    markdown: all.filter((_, i) => !drop.has(i)).join("\n"),
    files,
    lines,
  };
}

/**
 * 받은 노트 페이지(행 포함)의 폴더 첨부({@link folderFilesInNote}) — 이 페이지에 적어 둔 폴더 첨부 id 로도 찾고, 로컬 노트가
 * 임베드한 이름 · 이 노트가 올린 미디어는 노트의 것으로 둔다. 페이지 받기와 행 받기가 같은 규칙을 읽는다.
 *
 * @returns `holdsAll` — 떼고 남은 본문에 적어 둔 폴더 첨부가 없나. 그럴 때만 빠진 파일을 Notion 에서 지운 것으로 본다.
 */
export function noteFolderFilesOfPage(
  stateDb: IStateDB,
  pageId: string,
  markdown: string,
  embedded?: ReadonlySet<string>,
): { readonly found: NoteFolderFiles | null; readonly holdsAll: boolean } {
  const ids = new Set(folderFileIdsOf(stateDb, pageId).values());
  const media = recallUploadedMedia(stateDb, pageId);
  const found = folderFilesInNote(markdown, {
    knownIds: ids,
    exclude: (file) => {
      const fileId = notionFileIdOf(file.url);
      return embedded?.has(file.name) === true || (fileId !== null && media.has(fileId));
    },
  });
  const rest = found?.markdown ?? markdown;
  return {
    found,
    holdsAll:
      ids.size === 0 ||
      !notionMediaSpans(rest).some((span) => ids.has(notionFileIdOf(span.url) ?? "")),
  };
}

/**
 * 볼트 맨 위 파일을 싣는 Notion 페이지 — 페이지 모드의 루트. 볼트 맨 위는 루트 페이지의 자리라 그 끝에 「📁 이름」 으로
 * 싣는다(노트 이름의 폴더와 같은 규칙). DB 모드의 루트는 DB 라 본문이 없다 — null.
 */
export function rootFilesPageOf(config: Config): string | null {
  if (isDatabaseMode(config) || !config.notion.rootPageId) return null;
  return normalizeNotionId(config.notion.rootPageId);
}

/** 노트에 붙인(임베드한) 대상 — `![[x]]` · `![](x)` · frontmatter 의 `[[x]]`(아이콘 · 커버). */
const WIKI_EMBED_RE = /!\[\[([^\]|#^\n]+)/g;
const MD_EMBED_RE = /!\[[^\]\n]*\]\(<?([^)>\s]+)/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const WIKILINK_TARGET_RE = /\[\[([^\]|#^\n]+)/g;

function baseNameOf(target: string): string {
  let decoded = target.trim();
  try {
    decoded = decodeURI(decoded);
  } catch {
    // 잘못된 퍼센트 인코딩은 적힌 그대로 본다
  }
  return decoded.slice(decoded.lastIndexOf("/") + 1).normalize("NFC");
}

/**
 * 노트들이 붙인 파일의 이름(경로 마지막 칸) — 붙인 파일은 노트와 함께 올라가므로 폴더 첨부로 다시 올리지 않는다. Obsidian 은
 * 이름만으로도 찾으므로 경로가 아니라 이름으로 본다. 같은 이름의 다른 파일을 하나 덜 올릴 수는 있어도 같은 파일을 두 번
 * 올리지는 않는다.
 */
export function embeddedNamesOf(notes: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of notes) {
    for (const m of text.matchAll(WIKI_EMBED_RE)) names.add(baseNameOf(m[1]!));
    for (const m of text.matchAll(MD_EMBED_RE)) names.add(baseNameOf(m[1]!));
    const frontmatter = FRONTMATTER_RE.exec(text)?.[1];
    if (frontmatter) {
      for (const m of frontmatter.matchAll(WIKILINK_TARGET_RE)) names.add(baseNameOf(m[1]!));
    }
  }
  return names;
}

/**
 * sync_metadata 의 키 — 폴더 페이지마다 한 줄(`uploaded_media:` 와 같은 방식이라 스키마를 바꾸지 않는다). 값은 볼트 경로 →
 * Notion 이 그 파일을 저장한 id(`notionFileIdOf`). 이름이 같아도 파일을 바꾸면 id 가 바뀐다 — pull 이 이것으로 Notion
 * 쪽에서 바뀐 폴더 첨부를 알아본다.
 */
function keyOf(pageId: string): string {
  return `folder_files:${compactNotionId(pageId)}`;
}

/** sync_metadata 한 줄의 경로 → 값 표. 읽지 못하면 빈 표. */
function readPathMap(stateDb: IStateDB, key: string): Map<string, string> {
  const raw = stateDb.getMeta(key);
  if (!raw) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
  } catch {
    return new Map();
  }
}

function writePathMap(stateDb: IStateDB, key: string, map: ReadonlyMap<string, string>): void {
  stateDb.setMeta(key, JSON.stringify(Object.fromEntries(map)));
}

/** 이 폴더 페이지에 적어 둔 폴더 첨부의 Notion 파일 id. */
export function folderFileIdsOf(stateDb: IStateDB, pageId: string): Map<string, string> {
  return readPathMap(stateDb, keyOf(pageId));
}

/** 폴더 첨부의 Notion 파일 id 를 지운다 — 볼트 · Notion 어느 쪽에서든 지운 파일. 볼트 파일의 표({@link fileStampOf})도. */
export function forgetFolderFileId(stateDb: IStateDB, pageId: string, localPath: string): void {
  rememberFolderFileStamp(stateDb, pageId, localPath, null);
  const ids = folderFileIdsOf(stateDb, pageId);
  if (!ids.delete(localPath)) return;
  writePathMap(stateDb, keyOf(pageId), ids);
}

/** 폴더 첨부의 Notion 파일 id 를 적는다 — 같은 경로는 바꾼다. */
export function rememberFolderFileId(
  stateDb: IStateDB,
  pageId: string,
  localPath: string,
  fileId: string,
): void {
  const ids = folderFileIdsOf(stateDb, pageId);
  if (ids.get(localPath) === fileId) return;
  ids.set(localPath, fileId);
  writePathMap(stateDb, keyOf(pageId), ids);
}

/**
 * 볼트 파일의 표 — 크기와 수정 시각. 올리거나 받은 때의 표와 같으면 그 뒤로 고치지 않았다. 예전에는 크기만 견줘, 같은 크기로
 * 고친 파일(CSV 의 숫자 하나)을 올리지 않았다.
 */
export function fileStampOf(file: { readonly size: number; readonly mtime: string }): string {
  return `${file.size}:${file.mtime}`;
}

function stampKeyOf(pageId: string): string {
  return `folder_file_stamps:${compactNotionId(pageId)}`;
}

/** 이 페이지에 올리거나 받은 파일의 볼트 쪽 표({@link fileStampOf}). */
export function folderFileStampsOf(stateDb: IStateDB, pageId: string): Map<string, string> {
  return readPathMap(stateDb, stampKeyOf(pageId));
}

/** 볼트 파일의 표를 적는다 — null 이면 지운다. */
export function rememberFolderFileStamp(
  stateDb: IStateDB,
  pageId: string,
  localPath: string,
  stamp: string | null,
): void {
  const stamps = folderFileStampsOf(stateDb, pageId);
  if ((stamps.get(localPath) ?? null) === stamp) return;
  if (stamp === null) stamps.delete(localPath);
  else stamps.set(localPath, stamp);
  writePathMap(stateDb, stampKeyOf(pageId), stamps);
}
