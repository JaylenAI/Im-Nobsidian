import type { VaultFS } from "../sync/vault-fs.js";
import type { DBEntry, PropertyValue } from "./types.js";
import matter from "gray-matter";

export class EntryEditor {
  constructor(private readonly vaultFs: VaultFS) {}

  async updateProperty(
    entryPath: string,
    propertyName: string,
    newValue: PropertyValue,
  ): Promise<void> {
    const content = await this.vaultFs.readFile(entryPath);
    const parsed = matter(content);

    parsed.data[propertyName] = newValue;

    const updated = matter.stringify(parsed.content, parsed.data);
    await this.vaultFs.writeFile(entryPath, updated);
  }

  async createEntry(
    folderPath: string,
    title: string,
    properties: Record<string, PropertyValue>,
  ): Promise<string> {
    const safeName = title.replace(/[\\/:*?"<>|]/g, "_").trim() || "Untitled";
    const filePath = `${folderPath}/${safeName}.md`;

    const frontmatter = { title, ...properties };
    const content = matter.stringify("", frontmatter);

    await this.vaultFs.ensureFolder(folderPath);
    await this.vaultFs.writeFile(filePath, content);

    return filePath;
  }

  async moveEntryToGroup(
    entry: DBEntry,
    groupProperty: string,
    newGroupValue: string,
  ): Promise<void> {
    await this.updateProperty(entry.path, groupProperty, newGroupValue);
  }

  async updateDate(entryPath: string, dateProperty: string, newDate: string): Promise<void> {
    await this.updateProperty(entryPath, dateProperty, newDate);
  }
}
