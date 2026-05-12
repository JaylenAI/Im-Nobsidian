type NotionPropertySchema = {
  id: string;
  type: string;
  name: string;
};

type NotionPropertyValue = Record<string, unknown>;

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/;

export class PropertyMapper {
  private schema: Map<string, NotionPropertySchema> = new Map();

  loadSchema(properties: Record<string, { id: string; type: string }>): void {
    this.schema.clear();
    for (const [name, prop] of Object.entries(properties)) {
      this.schema.set(name, { id: prop.id, type: prop.type, name });
    }
  }

  toNotionProperties(
    frontmatter: Record<string, unknown>,
    title: string,
  ): Record<string, NotionPropertyValue> {
    const result: Record<string, NotionPropertyValue> = {
      title: { title: [{ text: { content: title } }] },
    };

    for (const [key, value] of Object.entries(frontmatter)) {
      if (key === "title") continue;
      if (value === null || value === undefined) continue;

      const schemaProp = this.schema.get(key);
      if (schemaProp) {
        const converted = this.convertBySchema(schemaProp.type, value);
        if (converted) result[key] = converted;
      } else {
        const inferred = this.inferAndConvert(value);
        if (inferred) result[key] = inferred;
      }
    }

    return result;
  }

  fromNotionProperties(notionProps: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, rawProp] of Object.entries(notionProps)) {
      const prop = rawProp as { type: string; [k: string]: unknown };
      if (prop.type === "title") continue;
      const value = this.extractValue(prop);
      if (value !== undefined) {
        result[key] = value;
      }
    }

    return result;
  }

  private convertBySchema(type: string, value: unknown): NotionPropertyValue | null {
    switch (type) {
      case "rich_text":
        return { rich_text: [{ text: { content: String(value) } }] };

      case "number":
        return { number: typeof value === "number" ? value : Number(value) };

      case "select":
        return { select: { name: String(value) } };

      case "multi_select": {
        const items = Array.isArray(value)
          ? value
          : String(value)
              .split(",")
              .map((s) => s.trim());
        return { multi_select: items.map((name: unknown) => ({ name: String(name) })) };
      }

      case "checkbox":
        return { checkbox: Boolean(value) };

      case "date": {
        const dateStr = String(value);
        if (DATE_REGEX.test(dateStr)) {
          return { date: { start: dateStr } };
        }
        return null;
      }

      case "url":
        return { url: String(value) };

      case "email":
        return { email: String(value) };

      case "phone_number":
        return { phone_number: String(value) };

      case "status":
        return { status: { name: String(value) } };

      default:
        return { rich_text: [{ text: { content: String(value) } }] };
    }
  }

  private inferAndConvert(value: unknown): NotionPropertyValue | null {
    if (typeof value === "boolean") {
      return { checkbox: value };
    }
    if (typeof value === "number") {
      return { number: value };
    }
    if (Array.isArray(value)) {
      return {
        multi_select: value.map((v) => ({ name: String(v) })),
      };
    }
    if (typeof value === "string") {
      if (DATE_REGEX.test(value)) {
        return { date: { start: value } };
      }
      if (value.startsWith("http://") || value.startsWith("https://")) {
        return { url: value };
      }
      return { rich_text: [{ text: { content: value } }] };
    }
    return null;
  }

  private extractValue(prop: { type: string; [k: string]: unknown }): unknown {
    switch (prop.type) {
      case "rich_text": {
        const arr = prop.rich_text as Array<{ plain_text: string }> | undefined;
        return arr?.map((t) => t.plain_text).join("") || null;
      }
      case "number":
        return prop.number;
      case "select": {
        const sel = prop.select as { name: string } | null;
        return sel?.name ?? null;
      }
      case "multi_select": {
        const items = prop.multi_select as Array<{ name: string }> | undefined;
        return items?.map((s) => s.name) ?? [];
      }
      case "checkbox":
        return prop.checkbox;
      case "date":
        return prop.date ?? null;
      case "url":
        return prop.url;
      case "email":
        return prop.email;
      case "phone_number":
        return prop.phone_number;
      case "status": {
        const status = prop.status as { name: string } | null;
        return status?.name ?? null;
      }
      case "created_time":
        return prop.created_time;
      case "last_edited_time":
        return prop.last_edited_time;
      case "people": {
        const people = prop.people as Array<{ name?: string; id: string }> | undefined;
        return people?.map((p) => p.name ?? p.id) ?? [];
      }
      case "files": {
        const files = prop.files as
          | Array<{
              name: string;
              type: string;
              file?: { url: string };
              external?: { url: string };
            }>
          | undefined;
        return (
          files?.map((f) => ({
            name: f.name,
            url: f.type === "file" ? f.file?.url : f.external?.url,
          })) ?? []
        );
      }
      case "formula": {
        const formula = prop.formula as { type: string; [k: string]: unknown } | undefined;
        if (!formula) return null;
        return formula[formula.type];
      }
      case "relation": {
        const rel = prop.relation as Array<{ id: string }> | undefined;
        return rel?.map((r) => r.id) ?? [];
      }
      case "rollup": {
        const rollup = prop.rollup as { type: string; [k: string]: unknown } | undefined;
        if (!rollup) return null;
        if (rollup.type === "array") {
          const arr = rollup.array as Array<{ type: string; [k: string]: unknown }>;
          return arr.map((item) => this.extractValue(item));
        }
        return rollup[rollup.type] ?? null;
      }
      case "unique_id": {
        const uid = prop.unique_id as { prefix?: string; number: number } | undefined;
        if (!uid) return null;
        return uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
      }
      case "created_by":
      case "last_edited_by": {
        const user = prop[prop.type] as { name?: string; id: string } | undefined;
        return user?.name ?? user?.id ?? null;
      }
      case "verification": {
        const v = prop.verification as { state: string } | undefined;
        return v?.state ?? null;
      }
      default:
        return null;
    }
  }
}
