/**
 * 메모리 볼트 · 메모리 Notion — 실제 StateDB 와 함께 push · pull 을 끝까지 돌리는 시험의 하니스.
 *
 * 레코드를 손으로 심지 않고 처음 push 가 만든 것을 그대로 이어 쓰려면, 볼트는 이름 변경 ·
 * 수정 시각을, Notion 은 만든 페이지의 제목 · 부모 · 수정 시각을 기억해야 한다. 시험마다 따로
 * 두면 한쪽만 고쳐져 같은 동작을 서로 다르게 흉내 낸다.
 */
import type { VaultFS } from "../../src/sync/vault-fs.js";
import { createMockNotionClient, createMockVaultFs } from "./mock-orchestrator.js";

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
  lastEdited: string;
  archived: boolean;
  /** 본문 — 만들 때 · 바꿀 때 보낸 markdown. 자식 페이지 태그는 읽을 때 붙인다. */
  body: string;
}

/** 메모리 Notion — 만든 페이지의 제목 · 부모 · 수정 시각을 기억한다. */
export function memoryNotion() {
  const client = createMockNotionClient();
  const pages = new Map<string, MemoryPage>();
  let clock = 0;
  const tick = () => new Date(Date.UTC(2026, 8, 2) + ++clock * 1000).toISOString();
  const view = (page: MemoryPage) => ({
    id: page.id,
    last_edited_time: page.lastEdited,
    archived: page.archived,
    in_trash: page.archived,
    parent: { type: "page_id", page_id: page.parent },
    properties: { title: { id: "title", type: "title", title: [{ plain_text: page.title }] } },
  });
  const find = (id: string): MemoryPage => {
    const page = pages.get(id);
    if (!page) throw new Error(`object_not_found: ${id}`);
    return page;
  };
  const touch = (id: string): MemoryPage => {
    const page = find(id);
    page.lastEdited = tick();
    return page;
  };
  const add = (parent: string, title: string, body = ""): MemoryPage => {
    const id = `00000000-0000-4000-8000-${String(pages.size + 1).padStart(12, "0")}`;
    const page = { id, title, parent, lastEdited: tick(), archived: false, body };
    pages.set(id, page);
    return page;
  };
  const create = async ({
    parentId,
    title,
    markdown,
  }: {
    parentId: string;
    title: string;
    markdown?: string;
  }) => view(add(parentId, title, markdown));
  // Notion Markdown API 처럼 본문 뒤에 자식 페이지를 `<page>` 태그로 싣는다(휴지통 제외).
  const markdownOf = (id: string): string => {
    const children = [...pages.values()]
      .filter((page) => page.parent === id && !page.archived)
      .map(
        (page) =>
          `<page url="https://www.notion.so/${page.id.replace(/-/g, "")}">${page.title}</page>`,
      );
    return [find(id).body, ...children].filter((part) => part.length > 0).join("\n");
  };

  client.createPageWithMarkdown.mockImplementation(create);
  client.createPage.mockImplementation(create);
  client.getPage.mockImplementation(async (id: string) => view(find(id)));
  client.extractTitle.mockImplementation(
    (page: { properties: { title: { title: Array<{ plain_text: string }> } } }) =>
      page.properties.title.title.map((t) => t.plain_text).join(""),
  );
  client.movePage.mockImplementation(async (id: string, parentId: string) => {
    touch(id).parent = parentId;
  });
  client.updatePageProperties.mockImplementation(
    async (id: string, props: { title?: { title: Array<{ text: { content: string } }> } }) => {
      const page = touch(id);
      if (props.title) page.title = props.title.title.map((t) => t.text.content).join("");
      return view(page);
    },
  );
  client.replacePageMarkdown.mockImplementation(async (id: string, markdown: string) => {
    touch(id).body = markdown;
    return { markdown: "", truncated: false, unknown_block_ids: [] };
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
    [...pages.values()].map((page) => ({ id: page.id, last_edited_time: page.lastEdited })),
  );
  // 전체 대조(deleteSync)의 순회 — 루트 아래의 휴지통이 아닌 페이지. Notion 은 부모를 휴지통에
  // 넣으면 그 아래도 함께 넣는다 — 시험이 둘 다 표시한다.
  client.getChildPagesRecursive.mockImplementation(async (rootId: string) => {
    const found: Array<ReturnType<typeof view>> = [];
    const walk = (parentId: string): void => {
      for (const page of pages.values()) {
        if (page.parent !== parentId || page.archived) continue;
        found.push(view(page));
        walk(page.id);
      }
    };
    walk(rootId);
    return found;
  });
  // 휴지통의 자식은 목록에 잡히지 않는다 — 생성 요청이 적용됐는지 모를 때 찾는 경로가 이것을 읽는다.
  client.fetchAllChildren.mockImplementation(async (parentId: string) =>
    [...pages.values()]
      .filter((page) => page.parent === parentId && !page.archived)
      .map((page) => ({ id: page.id, type: "child_page", child_page: { title: page.title } })),
  );
  return { client, pages, add, touch };
}
