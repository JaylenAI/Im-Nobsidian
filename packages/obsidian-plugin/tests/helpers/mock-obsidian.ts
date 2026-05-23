import { vi } from "vitest";

export interface MockTFile {
  path: string;
  name: string;
  extension: string;
  stat: { mtime: number; size: number; ctime: number };
  parent: MockTFolder | null;
  basename: string;
}

export interface MockTFolder {
  path: string;
  name: string;
  children: (MockTFile | MockTFolder)[];
}

export function createMockTFile(
  path: string,
  opts?: { size?: number; mtime?: number; content?: string },
): MockTFile {
  const parts = path.split("/");
  const name = parts[parts.length - 1]!;
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  const basename = name.replace(`.${ext}`, "");

  return {
    path,
    name,
    extension: ext,
    stat: {
      mtime: opts?.mtime ?? Date.now(),
      size: opts?.size ?? 100,
      ctime: Date.now(),
    },
    parent: null,
    basename,
  };
}

export function createMockVault(files: Map<string, { content: string; file: MockTFile }>) {
  const vault = {
    getAbstractFileByPath: vi.fn((p: string) => {
      const entry = files.get(p);
      return entry?.file ?? null;
    }),
    read: vi.fn(async (file: MockTFile) => {
      const entry = files.get(file.path);
      return entry?.content ?? "";
    }),
    readBinary: vi.fn(async (_file: MockTFile) => {
      return new ArrayBuffer(8);
    }),
    modify: vi.fn(async (file: MockTFile, content: string) => {
      const entry = files.get(file.path);
      if (entry) entry.content = content;
    }),
    modifyBinary: vi.fn(async () => {}),
    create: vi.fn(async (path: string, content: string) => {
      const file = createMockTFile(path);
      files.set(path, { content, file });
      return file;
    }),
    createBinary: vi.fn(async (path: string) => {
      const file = createMockTFile(path);
      files.set(path, { content: "", file });
      return file;
    }),
    createFolder: vi.fn(async () => {}),
    rename: vi.fn(async (file: MockTFile, newPath: string) => {
      const entry = files.get(file.path);
      if (entry) {
        files.delete(file.path);
        file.path = newPath;
        files.set(newPath, entry);
      }
    }),
    trash: vi.fn(async (file: MockTFile) => {
      files.delete(file.path);
    }),
    getMarkdownFiles: vi.fn(() => {
      return [...files.values()].filter((e) => e.file.extension === "md").map((e) => e.file);
    }),
    getFiles: vi.fn(() => {
      return [...files.values()].map((e) => e.file);
    }),
  };

  return vault;
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}
