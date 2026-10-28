/**
 * 같은 이름의 두 겹 폴더 페이지 — v0.3.x · v0.4 개발 빌드가 남긴 것을 찾는다(ADR-012 트레이드오프).
 *
 * 예전 push 는 새 폴더 `F` 와 폴더 노트 `F/F.md` 를 한 번에 올리면 폴더 페이지 F 를 만들고, 폴더 노트를 그
 * «아래» 에 같은 제목의 자식으로 만들었다. 다음 push 가 폴더 레코드를 놓으면 그다음 pull 이 폴더 페이지를
 * `F/F (id).md` 로 받았다. ADR-012 뒤로는 생기지 않지만 이미 생긴 것은 그대로다 — 어느 쪽을 지울지는 사람이
 * 정한다. 여기서는 고치지 않고 찾아서 알리기만 한다.
 *
 * 상태 DB 만 본다 — Notion 을 부르지 않는다. 한 쌍은 «폴더 F 를 나타내는 두 레코드» 이고 안쪽의 Notion 부모가
 * 바깥쪽이다. 폴더 F 를 나타내는 레코드는 폴더 레코드(`F`)이거나 폴더 노트 꼴의 노트(`F/F.md` ·
 * `F/F (id).md`)다.
 */
import { isFolderRecord } from "../sync/folder-container.js";
import { PAGE_ID_SUFFIX_LENGTHS } from "../utils/db-row-path.js";
import { compactNotionId } from "../utils/id.js";
import { stripMarkdownExtension } from "../utils/markdown-path.js";

/** 찾을 레코드 — {@link IStateDB.getAll} 이 그대로 만족한다. */
export interface NestedFolderRecord {
  readonly obsidianPath: string;
  readonly notionPageId: string | null;
  readonly notionParentId: string | null;
  readonly fileType: string;
}

/** 두 겹 하나 — 바깥(Notion 부모)과 안쪽(같은 이름의 자식). */
export interface NestedFolderPage {
  /** 두 겹이 나타내는 볼트 폴더. */
  readonly folder: string;
  readonly outer: { readonly path: string; readonly notionPageId: string };
  readonly inner: { readonly path: string; readonly notionPageId: string };
}

/** pull 이 같은 이름 페이지에 붙이는 id 꼬리 — `pagePathCandidates` 와 같은 길이. */
const ID_SUFFIX = new RegExp(
  ` \\((?:${PAGE_ID_SUFFIX_LENGTHS.map((len) => `[0-9a-f]{${len}}`).join("|")})\\)$`,
);

/** 이 레코드가 나타내는 폴더 — 폴더 레코드거나 폴더 노트 꼴(꼬리 무시)이면 그 폴더, 아니면 null. */
function folderOf(record: NestedFolderRecord): string | null {
  if (record.fileType === "db-row") return null;
  if (isFolderRecord(record)) return record.obsidianPath;
  const slash = record.obsidianPath.lastIndexOf("/");
  if (slash < 0) return null;
  const folder = record.obsidianPath.slice(0, slash);
  const stem = stripMarkdownExtension(record.obsidianPath.slice(slash + 1)).replace(ID_SUFFIX, "");
  return stem === folder.slice(folder.lastIndexOf("/") + 1) ? folder : null;
}

/** 같은 폴더를 나타내면서 Notion 에서 부모 · 자식인 레코드 쌍. 폴더 경로 순. */
export function findNestedFolderPages(records: readonly NestedFolderRecord[]): NestedFolderPage[] {
  const byPage = new Map<string, NestedFolderRecord>();
  for (const record of records) {
    if (record.notionPageId !== null) byPage.set(compactNotionId(record.notionPageId), record);
  }
  const found: NestedFolderPage[] = [];
  for (const inner of records) {
    if (inner.notionPageId === null || inner.notionParentId === null) continue;
    const folder = folderOf(inner);
    if (folder === null) continue;
    const outer = byPage.get(compactNotionId(inner.notionParentId));
    if (!outer || outer === inner || folderOf(outer) !== folder) continue;
    found.push({
      folder,
      outer: { path: outer.obsidianPath, notionPageId: outer.notionPageId! },
      inner: { path: inner.obsidianPath, notionPageId: inner.notionPageId },
    });
  }
  return found.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}
