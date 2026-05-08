import { describe, it, expect } from "vitest";
import { TreeMapper } from "../../src/structure/tree-mapper.js";
import type { NotionPageNode, FileSystemEntry } from "../../src/structure/tree-mapper.js";

describe("TreeMapper", () => {
  const mapper = new TreeMapper();

  describe("mapNotionToObsidian", () => {
    it("콘텐츠만 있는 페이지 → .md 파일", () => {
      const page: NotionPageNode = {
        id: "p1",
        title: "Simple Note",
        hasContent: true,
        hasChildren: false,
        isDatabase: false,
        parentId: null,
        children: [],
      };

      const results = mapper.mapNotionToObsidian(page);
      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe("file");
      expect(results[0]!.obsidianPath).toBe("Simple Note.md");
    });

    it("하위 페이지만 있음 (콘텐츠 없음) → 폴더", () => {
      const page: NotionPageNode = {
        id: "p2",
        title: "Projects",
        hasContent: false,
        hasChildren: true,
        isDatabase: false,
        parentId: null,
        children: [
          {
            id: "p3",
            title: "Project A",
            hasContent: true,
            hasChildren: false,
            isDatabase: false,
            parentId: "p2",
            children: [],
          },
        ],
      };

      const results = mapper.mapNotionToObsidian(page);
      expect(results).toHaveLength(2);
      expect(results[0]!.type).toBe("folder-only");
      expect(results[0]!.folderPath).toBe("Projects/");
      expect(results[1]!.type).toBe("file");
      expect(results[1]!.obsidianPath).toBe("Projects/Project A.md");
    });

    it("콘텐츠 + 하위 페이지 → 폴더 노트", () => {
      const page: NotionPageNode = {
        id: "p4",
        title: "Guide",
        hasContent: true,
        hasChildren: true,
        isDatabase: false,
        parentId: null,
        children: [
          {
            id: "p5",
            title: "Chapter 1",
            hasContent: true,
            hasChildren: false,
            isDatabase: false,
            parentId: "p4",
            children: [],
          },
        ],
      };

      const results = mapper.mapNotionToObsidian(page);
      expect(results).toHaveLength(2);
      expect(results[0]!.type).toBe("folder-note");
      expect(results[0]!.notePath).toBe("Guide/Guide.md");
      expect(results[0]!.folderPath).toBe("Guide/");
      expect(results[1]!.type).toBe("file");
      expect(results[1]!.obsidianPath).toBe("Guide/Chapter 1.md");
    });

    it("Database → 폴더 + _schema.yml", () => {
      const page: NotionPageNode = {
        id: "db1",
        title: "Tasks",
        hasContent: false,
        hasChildren: true,
        isDatabase: true,
        parentId: null,
        children: [],
      };

      const results = mapper.mapNotionToObsidian(page);
      expect(results).toHaveLength(1);
      expect(results[0]!.type).toBe("database-folder");
      expect(results[0]!.schemaPath).toBe("Tasks/_schema.yml");
    });

    it("깊은 중첩 구조", () => {
      const page: NotionPageNode = {
        id: "root",
        title: "Vault",
        hasContent: false,
        hasChildren: true,
        isDatabase: false,
        parentId: null,
        children: [
          {
            id: "c1",
            title: "Area",
            hasContent: false,
            hasChildren: true,
            isDatabase: false,
            parentId: "root",
            children: [
              {
                id: "c2",
                title: "Deep Note",
                hasContent: true,
                hasChildren: false,
                isDatabase: false,
                parentId: "c1",
                children: [],
              },
            ],
          },
        ],
      };

      const results = mapper.mapNotionToObsidian(page);
      expect(results).toHaveLength(3);
      expect(results[2]!.obsidianPath).toBe("Vault/Area/Deep Note.md");
    });

    it("특수문자 포함 제목 안전화", () => {
      const page: NotionPageNode = {
        id: "p6",
        title: "What/Why?",
        hasContent: true,
        hasChildren: false,
        isDatabase: false,
        parentId: null,
        children: [],
      };

      const results = mapper.mapNotionToObsidian(page);
      expect(results[0]!.obsidianPath).not.toContain("/");
      expect(results[0]!.obsidianPath).not.toContain("?");
    });
  });

  describe("mapObsidianToNotion", () => {
    it("일반 .md 파일 → leaf-page 계획", () => {
      const entries: FileSystemEntry[] = [
        { name: "note.md", path: "note.md", isDirectory: false, children: [] },
      ];

      const plans = mapper.mapObsidianToNotion(entries, "root-id");
      expect(plans).toHaveLength(1);
      expect(plans[0]!.type).toBe("leaf-page");
      expect(plans[0]!.title).toBe("note");
      expect(plans[0]!.parentPageId).toBe("root-id");
    });

    it("폴더 + 폴더 노트 → page-with-children", () => {
      const entries: FileSystemEntry[] = [
        {
          name: "project",
          path: "project",
          isDirectory: true,
          children: [
            { name: "project.md", path: "project/project.md", isDirectory: false, children: [] },
            { name: "sub.md", path: "project/sub.md", isDirectory: false, children: [] },
          ],
        },
      ];

      const plans = mapper.mapObsidianToNotion(entries, "root-id");
      expect(plans[0]!.type).toBe("page-with-children");
      expect(plans[0]!.contentSource).toBe("project/project.md");
    });

    it("폴더 노트 없는 폴더 → empty-page-with-children", () => {
      const entries: FileSystemEntry[] = [
        {
          name: "folder",
          path: "folder",
          isDirectory: true,
          children: [{ name: "a.md", path: "folder/a.md", isDirectory: false, children: [] }],
        },
      ];

      const plans = mapper.mapObsidianToNotion(entries, "root-id");
      expect(plans[0]!.type).toBe("empty-page-with-children");
      expect(plans[0]!.hasContent).toBe(false);
    });
  });

  describe("determineFileType", () => {
    it("각 조합에 대해 올바른 타입 반환", () => {
      expect(
        mapper.determineFileType({ hasContent: true, hasChildren: false, isDatabase: false }),
      ).toBe("file");
      expect(
        mapper.determineFileType({ hasContent: true, hasChildren: true, isDatabase: false }),
      ).toBe("folder-note");
      expect(
        mapper.determineFileType({ hasContent: false, hasChildren: true, isDatabase: false }),
      ).toBe("folder-only");
      expect(
        mapper.determineFileType({ hasContent: false, hasChildren: true, isDatabase: true }),
      ).toBe("database-folder");
    });
  });
});
