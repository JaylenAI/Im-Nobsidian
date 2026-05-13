import { sanitizeFileName } from "../utils/sanitize.js";

export interface NotionPageNode {
  readonly id: string;
  readonly title: string;
  readonly hasContent: boolean;
  readonly hasChildren: boolean;
  readonly isDatabase: boolean;
  readonly parentId: string | null;
  readonly children: NotionPageNode[];
}

export type MappingType = "file" | "folder-note" | "folder-only" | "database-folder";

export interface MappingResult {
  readonly type: MappingType;
  readonly obsidianPath: string;
  readonly folderPath?: string;
  readonly notePath?: string;
  readonly schemaPath?: string;
}

export class TreeMapper {
  mapNotionToObsidian(root: NotionPageNode, basePath: string = ""): MappingResult[] {
    const results: MappingResult[] = [];
    this.mapRecursive(root, basePath, results);
    return results;
  }

  private mapRecursive(node: NotionPageNode, parentPath: string, results: MappingResult[]): void {
    const safeName = sanitizeFileName(node.title || "_untitled");
    const currentPath = parentPath ? `${parentPath}/${safeName}` : safeName;

    if (node.isDatabase) {
      results.push({
        type: "database-folder",
        obsidianPath: `${currentPath}/`,
        folderPath: `${currentPath}/`,
        schemaPath: `${currentPath}/_schema.yml`,
      });
    } else if (node.hasContent && node.hasChildren) {
      results.push({
        type: "folder-note",
        obsidianPath: `${currentPath}/${safeName}.md`,
        folderPath: `${currentPath}/`,
        notePath: `${currentPath}/${safeName}.md`,
      });
    } else if (!node.hasContent && node.hasChildren) {
      results.push({
        type: "folder-only",
        obsidianPath: `${currentPath}/`,
        folderPath: `${currentPath}/`,
      });
    } else {
      results.push({
        type: "file",
        obsidianPath: `${currentPath}.md`,
      });
    }

    for (const child of node.children) {
      this.mapRecursive(child, currentPath, results);
    }
  }

  mapObsidianToNotion(entries: FileSystemEntry[], parentPageId: string): PageCreationPlan[] {
    const plans: PageCreationPlan[] = [];
    this.planRecursive(entries, parentPageId, plans);
    return plans;
  }

  private planRecursive(
    entries: FileSystemEntry[],
    parentPageId: string,
    plans: PageCreationPlan[],
  ): void {
    for (const entry of entries) {
      if (entry.isDirectory) {
        const folderNote = this.findFolderNote(entry);

        if (folderNote) {
          plans.push({
            type: "page-with-children",
            title: entry.name,
            parentPageId,
            contentSource: folderNote.path,
            hasContent: true,
          });

          const childEntries = entry.children.filter((c) => c.path !== folderNote.path);
          this.planRecursive(childEntries, `placeholder:${entry.path}`, plans);
        } else {
          plans.push({
            type: "empty-page-with-children",
            title: entry.name,
            parentPageId,
            hasContent: false,
          });
          this.planRecursive(entry.children, `placeholder:${entry.path}`, plans);
        }
      } else if (entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
        plans.push({
          type: "leaf-page",
          title: entry.name.replace(/\.md$/, ""),
          parentPageId,
          contentSource: entry.path,
          hasContent: true,
        });
      }
    }
  }

  private findFolderNote(dir: FileSystemEntry): FileSystemEntry | null {
    return dir.children.find((c) => c.name === `${dir.name}.md` || c.name === "index.md") ?? null;
  }

  determineFileType(page: {
    hasContent: boolean;
    hasChildren: boolean;
    isDatabase: boolean;
  }): MappingType {
    if (page.isDatabase) return "database-folder";
    if (page.hasContent && page.hasChildren) return "folder-note";
    if (!page.hasContent && page.hasChildren) return "folder-only";
    return "file";
  }
}

export interface FileSystemEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly children: FileSystemEntry[];
}

export interface PageCreationPlan {
  readonly type: "page-with-children" | "empty-page-with-children" | "leaf-page";
  readonly title: string;
  readonly parentPageId: string;
  readonly contentSource?: string;
  readonly hasContent: boolean;
}
