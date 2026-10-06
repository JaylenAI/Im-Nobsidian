/**
 * 메모리 볼트 · 메모리 Notion — 실제 StateDB 와 함께 push · pull 을 끝까지 돌리는 시험의 하니스.
 *
 * 레코드를 손으로 심지 않고 처음 push 가 만든 것을 그대로 이어 쓰려면, 볼트는 이름 변경 ·
 * 수정 시각을, Notion 은 만든 페이지의 제목 · 부모 · 수정 시각을 기억해야 한다. 시험마다 따로
 * 두면 한쪽만 고쳐져 같은 동작을 서로 다르게 흉내 낸다.
 */
import { deferredCodeMarker } from "../../src/constants/markers.js";
import { NotionClient } from "../../src/notion/client.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import { EDIT_TIME_RESOLUTION_MS } from "../../src/sync/remote-observation.js";
import {
  createMockNotionClient,
  createMockVaultFs,
  MOCK_BOT_USER_ID,
} from "./mock-orchestrator.js";

/** 메모리 볼트 — 이름을 바꿔도 내용 · 수정 시각은 그대로다(파일 시스템의 rename 처럼). */
export class MemoryVault {
  readonly files = new Map<string, { content: string; mtime: string }>();
  readonly folders = new Set<string>();
  private clock = 0;

  write(path: string, content: string): void {
    this.files.set(path, { content, mtime: this.tick() });
    this.addFolders(path);
  }

  rename(from: string, to: string): void {
    const file = this.files.get(from);
    if (!file) throw new Error(`no file: ${from}`);
    this.files.delete(from);
    this.files.set(to, file);
    this.addFolders(to);
  }

  renameFolder(from: string, to: string): void {
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`${from}/`)) this.rename(path, to + path.slice(from.length));
    }
    for (const folder of [...this.folders]) {
      if (folder === from || folder.startsWith(`${from}/`)) {
        this.folders.delete(folder);
        this.folders.add(to + folder.slice(from.length));
      }
    }
  }

  read(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  stat(path: string): { path: string; mtime: string; size: number } | null {
    const file = this.files.get(path);
    return file
      ? { path, mtime: file.mtime, size: Buffer.byteLength(file.content, "utf-8") }
      : null;
  }

  fs(): VaultFS {
    const fs = createMockVaultFs();
    const markdown = () => [...this.files.keys()].filter((path) => path.endsWith(".md")).sort();
    fs.listMarkdownFileStats.mockImplementation(async () => markdown().map((p) => this.stat(p)!));
    fs.listMarkdownFiles.mockImplementation(async () =>
      markdown().map((path) => ({
        path,
        content: this.files.get(path)!.content,
        mtime: this.files.get(path)!.mtime,
      })),
    );
    fs.readFile.mockImplementation(async (path: string) => {
      const file = this.files.get(path);
      if (!file) throw new Error(`ENOENT: ${path}`);
      return file.content;
    });
    fs.getFileStat.mockImplementation(async (path: string) => this.stat(path));
    fs.exists.mockImplementation(
      async (path: string) => this.files.has(path) || this.folders.has(path),
    );
    fs.writeFile.mockImplementation(async (path: string, content: string) =>
      this.write(path, content),
    );
    // Obsidian 어댑터처럼 폴더 경로를 받으면 그 아래를 통째로 지운다(vault.trash 는 폴더도 받는다).
    fs.deleteFile.mockImplementation(async (path: string) => {
      this.files.delete(path);
      if (!this.folders.has(path)) return;
      for (const file of [...this.files.keys()]) {
        if (file.startsWith(`${path}/`)) this.files.delete(file);
      }
      for (const folder of [...this.folders]) {
        if (folder === path || folder.startsWith(`${path}/`)) this.folders.delete(folder);
      }
    });
    fs.ensureFolder.mockImplementation(async (folder: string) => this.addFolders(`${folder}/`));
    return fs as unknown as VaultFS;
  }

  private tick(): string {
    return new Date(Date.UTC(2026, 8, 1) + ++this.clock * 1000).toISOString();
  }

  private addFolders(path: string): void {
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
      this.folders.add(path.slice(0, i));
    }
  }
}

export interface MemoryPage {
  readonly id: string;
  title: string;
  parent: string;
  /** 부모가 DB 면 행이다 — 속성을 갖고, DB 조회(queryAllDatabasePages)로만 보인다. */
  readonly parentType: "page" | "database";
  /** 제목 밖의 속성 — Notion 이 돌려주는 모양(`{ type, [type]: 값 }`). */
  properties: Record<string, unknown>;
  lastEdited: string;
  /** 마지막으로 고친 사용자 — 이 통합이 고쳤으면 {@link MOCK_BOT_USER_ID}. */
  lastEditedBy: string;
  archived: boolean;
  /** 본문 — 만들 때 · 바꿀 때 보낸 markdown. 자식 페이지 태그는 읽을 때 붙인다. */
  body: string;
  /** 아이콘 · 커버 — Notion 이 돌려주는 모양. 없으면 undefined. */
  icon?: Record<string, unknown>;
  cover?: Record<string, unknown>;
}

/** Notion 에서 사람이 고친 것으로 적는 편집자 id. */
export const HUMAN_USER_ID = "human-user-id";

/** 본문을 쓴 뒤 블록으로 채우는 코드의 자리표시(S-22) — 한 페이지에 이만큼 넘게 쓰는 시험은 없다. */
const DEFERRED_CODE_TOKENS = new Set(Array.from({ length: 100 }, (_, i) => deferredCodeMarker(i)));

export interface MemoryNotionOptions {
  /**
   * 수정 시각을 이 기기 시계(`Date.now()`)로 적고 분 단위로 자른다 — Notion 처럼(N-05). 시험이
   * `vi.setSystemTime` 으로 시각을 정한다. 기본은 편집마다 1초씩 가는 시계라 시각이 늘 다르다.
   */
  readonly minuteClock?: boolean;
  /** 페이지 아래에 페이지를 만들면 부모의 수정 시각도 오른다 — Notion 처럼(실측, N-05). */
  readonly bumpParentOnCreate?: boolean;
}

type PropertyRequest = Record<string, unknown>;

/**
 * 보낸 속성 값(요청 모양)을 Notion 이 돌려주는 모양으로 — 글 조각은 pull 이 읽는 `plain_text` 와 조각의
 * 타입(`text` · `mention` · `equation`)을 채운다. 요청은 타입을 적지 않아도 된다(SDK 5.23.1).
 */
function storedProperty(request: PropertyRequest): Record<string, unknown> {
  const [type, value] = Object.entries(request)[0]!;
  const text = (items: unknown) =>
    (items as Array<{ type?: string; text?: { content?: string } }>).map((item) => ({
      type: item.type ?? ("mention" in item ? "mention" : "equation" in item ? "equation" : "text"),
      ...item,
      plain_text: item.text?.content ?? "",
    }));
  return { type, [type]: type === "rich_text" ? text(value) : value };
}

function titleOf(request: PropertyRequest): string {
  return (request.title as Array<{ text: { content: string } }>)
    .map((t) => t.text.content)
    .join("");
}

/** 메모리 Notion — 만든 페이지 · 행의 제목 · 부모 · 속성 · 수정 시각 · 편집자를 기억한다. */
export function memoryNotion(options: MemoryNotionOptions = {}) {
  const client = createMockNotionClient();
  const pages = new Map<string, MemoryPage>();
  let clock = 0;
  const tick = () =>
    options.minuteClock
      ? new Date(
          Math.floor(Date.now() / EDIT_TIME_RESOLUTION_MS) * EDIT_TIME_RESOLUTION_MS,
        ).toISOString()
      : new Date(Date.UTC(2026, 8, 2) + ++clock * 1000).toISOString();
  const view = (page: MemoryPage) => ({
    id: page.id,
    last_edited_time: page.lastEdited,
    last_edited_by: { object: "user", id: page.lastEditedBy },
    archived: page.archived,
    in_trash: page.archived,
    parent:
      page.parentType === "database"
        ? { type: "database_id", database_id: page.parent }
        : { type: "page_id", page_id: page.parent },
    properties: {
      title: { id: "title", type: "title", title: [{ plain_text: page.title }] },
      ...page.properties,
    },
    icon: page.icon ?? null,
    cover: page.cover ?? null,
  });
  // 없는 페이지는 SDK 처럼 404(`object_not_found`)로 던진다 — 받는 쪽이 «없음» 과 다른 오류를 가른다.
  const find = (id: string): MemoryPage => {
    const page = pages.get(id);
    if (!page) {
      throw Object.assign(new Error(`object_not_found: ${id}`), {
        code: "object_not_found",
        status: 404,
      });
    }
    return page;
  };
  /** 이 통합(봇)이 고친 것으로 적는다 — 사람의 편집은 {@link edit}. */
  const touch = (id: string, editor = MOCK_BOT_USER_ID): MemoryPage => {
    const page = find(id);
    page.lastEdited = tick();
    page.lastEditedBy = editor;
    return page;
  };
  /** Notion 에서 사람이 고친다 — 수정 시각과 편집자가 바뀐다. */
  const edit = (
    id: string,
    change: (page: MemoryPage) => void,
    editor = HUMAN_USER_ID,
  ): MemoryPage => {
    change(find(id));
    return touch(id, editor);
  };
  const add = (
    parent: string,
    title: string,
    body = "",
    row?: { readonly properties?: Record<string, PropertyRequest> },
  ): MemoryPage => {
    const id = `00000000-0000-4000-8000-${String(pages.size + 1).padStart(12, "0")}`;
    const properties = Object.fromEntries(
      Object.entries(row?.properties ?? {})
        .filter(([key]) => key !== "title")
        .map(([key, value]) => [key, storedProperty(value)]),
    );
    const page: MemoryPage = {
      id,
      title,
      parent,
      parentType: row ? "database" : "page",
      properties,
      lastEdited: tick(),
      lastEditedBy: MOCK_BOT_USER_ID,
      archived: false,
      body,
    };
    pages.set(id, page);
    if (options.bumpParentOnCreate && !row && pages.has(parent)) touch(parent);
    return page;
  };
  const create = async ({
    parentId,
    parentType,
    title,
    markdown,
    properties,
  }: {
    parentId: string;
    parentType?: "page" | "database";
    title: string;
    markdown?: string;
    properties?: Record<string, PropertyRequest>;
  }) =>
    view(add(parentId, title, markdown, parentType === "database" ? { properties } : undefined));
  // Notion Markdown API 처럼 본문 뒤에 자식 페이지를 `<page>` 태그로 싣는다(휴지통 제외).
  const markdownOf = (id: string): string => {
    const children = [...pages.values()]
      .filter((page) => page.parent === id && page.parentType === "page" && !page.archived)
      .map(
        (page) =>
          `<page url="https://www.notion.so/${page.id.replace(/-/g, "")}">${page.title}</page>`,
      );
    return [find(id).body, ...children].filter((part) => part.length > 0).join("\n");
  };

  // Notion 은 markdown 으로 만들 때 맨 앞 `# H1` 을 버린다(N-04, 실측). 본문 교체는 남긴다.
  client.createPageWithMarkdown.mockImplementation(
    async (params: { parentId: string; title: string; markdown: string }) =>
      create({ ...params, markdown: params.markdown.replace(/^\n*# [^\n]*\n?/, "") }),
  );
  client.createPage.mockImplementation(create);
  // 되살릴지는 제품이 정한다 — 전송(replacePageMarkdown)만 이 메모리로 흉내 낸다.
  client.restoreLeadingHeading.mockImplementation(async (id: string, markdown: string) =>
    NotionClient.prototype.restoreLeadingHeading.call(client as never, id, markdown),
  );
  client.getPage.mockImplementation(async (id: string) => view(find(id)));
  client.extractTitle.mockImplementation(
    (page: { properties: { title: { title: Array<{ plain_text: string }> } } }) =>
      page.properties.title.title.map((t) => t.plain_text).join(""),
  );
  client.extractIcon.mockImplementation((page: unknown) =>
    NotionClient.prototype.extractIcon.call(client as never, page as never),
  );
  client.extractCover.mockImplementation((page: unknown) =>
    NotionClient.prototype.extractCover.call(client as never, page as never),
  );
  client.movePage.mockImplementation(async (id: string, parentId: string) => {
    touch(id).parent = parentId;
  });
  client.updatePageProperties.mockImplementation(
    async (id: string, props: Record<string, PropertyRequest>) => {
      const page = touch(id);
      for (const [key, value] of Object.entries(props)) {
        if (key === "title") page.title = titleOf(value);
        else page.properties[key] = storedProperty(value);
      }
      return view(page);
    },
  );
  // DB 조회 — 휴지통이 아닌 행. 생성 요청이 적용됐는지 모를 때 행을 찾는 경로가 제목 조건을 쓴다.
  client.queryAllDatabasePages.mockImplementation(
    async (databaseId: string, filter?: { title?: { equals?: string } }) =>
      [...pages.values()]
        .filter(
          (page) =>
            page.parentType === "database" &&
            page.parent === databaseId &&
            !page.archived &&
            (filter?.title?.equals === undefined || page.title === filter.title.equals),
        )
        .map(view),
  );
  // 응답은 바꾼 뒤의 본문이다 — 다시 읽은 것과 같다(실측, N-05).
  client.replacePageMarkdown.mockImplementation(async (id: string, markdown: string) => {
    touch(id).body = markdown;
    return { markdown: markdownOf(id), truncated: false, unknown_block_ids: [] };
  });
  client.getPageMarkdown.mockImplementation(async (id: string) => ({
    markdown: markdownOf(id),
    truncated: false,
    unknown_block_ids: [],
  }));
  client.archivePage.mockImplementation(async (id: string) => {
    touch(id).archived = true;
  });
  client.searchRecentPages.mockImplementation(async () =>
    [...pages.values()].map((page) => ({
      id: page.id,
      last_edited_time: page.lastEdited,
      last_edited_by: { id: page.lastEditedBy },
      parentDatabaseId: page.parentType === "database" ? page.parent : null,
    })),
  );
  // 전체 대조(deleteSync)의 순회 — 루트 아래의 휴지통이 아닌 페이지. Notion 은 부모를 휴지통에
  // 넣으면 그 아래도 함께 넣는다 — 시험이 둘 다 표시한다.
  client.getChildPagesRecursive.mockImplementation(async (rootId: string) => {
    const found: Array<ReturnType<typeof view>> = [];
    const walk = (parentId: string): void => {
      for (const page of pages.values()) {
        if (page.parent !== parentId || page.parentType !== "page" || page.archived) continue;
        found.push(view(page));
        walk(page.id);
      }
    };
    walk(rootId);
    return found;
  });
  // 본문을 쓴 뒤 블록으로 채우는 코드(S-22) — 자리표시만 든 줄을 코드 블록으로 보이고, 그 글을 바꾸면
  // 줄을 코드로 바꾼다. Notion 은 코드 줄을 컨테이너 깊이와 상관없이 열 0 에 내보낸다(2026-10-04 실측) —
  // 맨 위 · 콜아웃 코드는 보낸 본문이 내보내는 모양과 같다. 목록 자식 코드는 들여쓰기를 탭으로 바꿔
  // 내보내므로 이 메모리로 흉내 내지 않는다.
  const codeTexts = new Map<string, string[]>();
  const deferredCodeBlocks = (id: string) =>
    (pages.get(id)?.body ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((text) => DEFERRED_CODE_TOKENS.has(text))
      .map((token) => ({
        id: `${id}#${token}`,
        type: "code",
        has_children: false,
        code: { language: "markdown", rich_text: [{ plain_text: token }] },
      }));
  client.updateCodeBlockText.mockImplementation(async (blockId: string, code: string) => {
    const [id, token] = blockId.split("#") as [string, string];
    const page = touch(id);
    page.body = page.body
      .split("\n")
      .map((line) => (line.trim() === token ? code : line))
      .join("\n");
    codeTexts.set(id, [...(codeTexts.get(id) ?? []), code]);
  });
  client.getCodeBlockTexts.mockImplementation(async (id: string) => codeTexts.get(id) ?? []);
  // 휴지통의 자식은 목록에 잡히지 않는다 — 생성 요청이 적용됐는지 모를 때 찾는 경로가 이것을 읽는다.
  client.fetchAllChildren.mockImplementation(async (parentId: string) => [
    ...deferredCodeBlocks(parentId),
    ...[...pages.values()]
      .filter((page) => page.parent === parentId && page.parentType === "page" && !page.archived)
      .map((page) => ({ id: page.id, type: "child_page", child_page: { title: page.title } })),
  ]);
  return { client, pages, add, touch, edit };
}
