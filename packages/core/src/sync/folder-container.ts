/**
 * 볼트 폴더가 Notion 에서 무엇인가 — push 가 새 노트를 어디에 만들고, 어떤 폴더를 페이지로
 * 만들어야 하는지 정한다(S-04).
 *
 * pull 이 볼트에 만드는 폴더는 세 가지다.
 *
 * - **페이지의 폴더**: 폴더 노트 `A/A.md` 가 그 페이지다. 폴더 노트 없이 push 가 만든 폴더
 *   페이지는 폴더 경로 자체(`A`)로 추적된다.
 * - **DB 폴더**: 자동 발견 · 설정 DB 의 행이 든 폴더. 폴더가 곧 DB 다 — 페이지가 아니다.
 * - **DB 를 품은 페이지의 폴더**: 폴더 노트가 아닌 페이지(`B.md`)나 행이 품은 DB 는 그 이름의
 *   하위 폴더 `B/<DB>` 에 든다. 폴더 `B` 는 형제 파일 `B.md` 의 페이지다.
 *
 * 예전 push 는 이 구분 없이 바뀐 파일의 조상 폴더를 모두 «폴더 페이지» 로 만들어, DB 폴더와
 * DB 를 품은 폴더가 Notion 에 빈 페이지로 생겼다.
 */

/** 폴더가 Notion 에서 차지하는 자리. */
export type FolderContainer =
  | { readonly kind: "database"; readonly databaseId: string }
  | { readonly kind: "page"; readonly pageId: string };

export interface FolderLookup {
  /** 이 폴더가 DB 폴더면 그 DB id. */
  databaseAt(folder: string): string | null;
  /** 이 경로를 추적하는 레코드의 Notion 페이지 id(없으면 null). */
  pageIdAt(path: string): string | null;
}

/** 폴더 노트인가 — 파일 이름이 든 폴더 이름과 같다(`A/A.md`). 그 폴더의 페이지다. */
export function isFolderNotePath(filePath: string): boolean {
  const parts = filePath.split("/");
  if (parts.length < 2) return false;
  return parts[parts.length - 1]!.replace(/\.md$/, "") === parts[parts.length - 2];
}

/** 파일이 아니라 폴더를 추적하는 레코드인가 — push 가 만든 폴더 페이지 · 폴더로만 받은 페이지. */
export function isFolderRecord(record: {
  readonly fileType: string;
  readonly obsidianPath: string;
}): boolean {
  return (
    (record.fileType === "folder-note" || record.fileType === "folder-only") &&
    !record.obsidianPath.endsWith(".md")
  );
}

/** 파일 · 폴더의 부모 폴더. 볼트 루트면 빈 문자열. */
export function parentFolderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** 파일의 조상 폴더 — 얕은 것부터. */
export function ancestorFolders(filePath: string): string[] {
  const parts = filePath.split("/");
  const folders: string[] = [];
  for (let i = 1; i < parts.length; i++) folders.push(parts.slice(0, i).join("/"));
  return folders;
}

/**
 * DB 폴더 → DB id. 설정 폴더는 끝 슬래시를 붙여 적기도 해 떼고 맞춘다.
 * 같은 폴더를 둘이 가리키면 먼저 적힌 것이 주인이다 — 설정을 자동 발견보다 앞에 둔다.
 */
export function databaseFolderIndex(
  entries: ReadonlyArray<{ readonly databaseId: string; readonly localFolder: string }>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const { databaseId, localFolder } of entries) {
    const folder = localFolder.replace(/\/+$/, "");
    if (folder && !index.has(folder)) index.set(folder, databaseId);
  }
  return index;
}

/**
 * 폴더의 Notion 자리. 아직 자리가 없으면 null — 페이지로 만들어야 하는 폴더다.
 *
 * DB 폴더를 먼저 본다. 행 제목이 DB 폴더 이름과 같으면 그 행이 폴더 노트처럼 보이고, v0.3 이
 * DB 폴더에 만든 폴더 레코드도 남아 있을 수 있다 — 둘 다 폴더를 페이지로 만들지 않는다.
 */
export function folderContainer(folder: string, lookup: FolderLookup): FolderContainer | null {
  const databaseId = lookup.databaseAt(folder);
  if (databaseId) return { kind: "database", databaseId };

  const name = folder.slice(folder.lastIndexOf("/") + 1);
  const pageId =
    lookup.pageIdAt(`${folder}/${name}.md`) ?? // 폴더 노트
    lookup.pageIdAt(folder) ?? // push 가 만든 폴더 페이지
    lookup.pageIdAt(`${folder}.md`); // DB 를 품은 페이지 · 행의 하위 폴더
  return pageId ? { kind: "page", pageId } : null;
}

/**
 * 이 폴더를 품은 DB 폴더 — 가장 가까운 «자리 있는» 조상이 DB 면 그 폴더, 아니면 null.
 *
 * DB 에는 행만 든다. DB 폴더 바로 아래의 행 이름이 아닌 폴더(`DB/기타`)는 Notion 에 같은
 * 것이 없어 페이지로 만들 자리가 없다. 행 이름의 폴더(`DB/행 A/…`)는 그 행 페이지의 하위라
 * 페이지를 만들 수 있다.
 */
export function enclosingDatabaseFolder(folder: string, lookup: FolderLookup): string | null {
  for (let current = parentFolderOf(folder); current; current = parentFolderOf(current)) {
    const container = folderContainer(current, lookup);
    if (container) return container.kind === "database" ? current : null;
  }
  return null;
}
