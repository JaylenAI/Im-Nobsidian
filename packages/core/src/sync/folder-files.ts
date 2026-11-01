/**
 * 폴더 첨부 — 노트에 붙이지 않고 폴더에 그냥 둔 파일(`proj/data.csv`). push 는 그 폴더의 Notion 페이지(폴더 페이지)에 파일
 * 블록으로 올리고, pull 은 같은 폴더에 같은 이름으로 받는다(ADR-054).
 *
 * 예전에는 받는 쪽이 폴더 페이지의 파일 블록을 «본문» 으로 보고 폴더 노트(`proj/proj.md`)를 새로 쓴 뒤 파일을 받은 그림
 * 폴더에 사본으로 받았다 — 올린 볼트도 다시 받으면 제 파일의 사본이 생겼다(2026-11-02 실측).
 */
import { CHILD_DATABASE_TAG_RE, CHILD_PAGE_TAG_RE } from "../converter/child-tags.js";
import type { IStateDB } from "../state/state-db-interface.js";
import { compactNotionId } from "../utils/id.js";
import { notionMediaSpans, uploadedFileNameFromUrl } from "./image-handler.js";

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
 * @param namedOnly 캡션이 파일 이름과 같은 파일만 폴더 첨부로 본다. 자식 페이지가 없는 페이지는 PDF 하나만 붙인 보통
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
    if (!name || (namedOnly && unescapeCaption(span.label) !== name)) return null;
    rest = rest.replace(span.full, "");
    files.push({ url: span.url, name });
  }
  return files.length > 0 && rest.trim() === "" ? files : null;
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

/** 이 폴더 페이지에 적어 둔 폴더 첨부의 Notion 파일 id. */
export function folderFileIdsOf(stateDb: IStateDB, pageId: string): Map<string, string> {
  const raw = stateDb.getMeta(keyOf(pageId));
  if (!raw) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
  } catch {
    return new Map();
  }
}

/** 폴더 첨부의 Notion 파일 id 를 지운다 — 볼트 · Notion 어느 쪽에서든 지운 파일. */
export function forgetFolderFileId(stateDb: IStateDB, pageId: string, localPath: string): void {
  const ids = folderFileIdsOf(stateDb, pageId);
  if (!ids.delete(localPath)) return;
  stateDb.setMeta(keyOf(pageId), JSON.stringify(Object.fromEntries(ids)));
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
  stateDb.setMeta(keyOf(pageId), JSON.stringify(Object.fromEntries(ids)));
}
