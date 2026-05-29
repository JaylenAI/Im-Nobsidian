type NotionPropertySchema = {
  id: string;
  type: string;
  name: string;
};

type NotionPropertyValue = Record<string, unknown>;

// ISO-8601 date / datetime. **양끝 앵커 필수** — 앵커가 없으면 "2026-05-29 마감" 처럼
// 날짜로 시작하는 일반 텍스트가 date 로 오분류되어 본문이 유실되고 Notion 에 잘못된
// 날짜가 전송된다. 초/밀리초/타임존(Z, ±HH:MM)까지 허용해 read→write 라운드트립을 보존.
const DATE_REGEX =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const WIKILINK_REGEX = /^\[\[(.+?)(?:\|.+?)?\]\]$/;

/**
 * Notion 은 비어 있는 배열형 속성값을 문서화된 `[]` 가 아니라 빈 객체 `{}` 로
 * 돌려주는 경우가 있다(특히 data source 분리 모델의 일부 행). `as Array<…>` 캐스트는
 * 이 불일치를 숨기고, 뒤따르는 `.map` 호출이 "X.map is not a function" 으로 그 행
 * 전체를 pull 실패시켜 **영구 데이터 손실 + 멱등성(churn) 위반**을 만든다.
 * 모든 배열 추출은 이 가드를 통과시켜, 배열이 아니면 안전하게 빈 배열로 강등한다.
 */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export interface WikilinkResolver {
  resolve(title: string): string | null;
  resolvePageId(pageId: string): string | null;
}

export class PropertyMapper {
  private schema: Map<string, NotionPropertySchema> = new Map();
  private wikilinkResolver: WikilinkResolver | null = null;

  setWikilinkResolver(resolver: WikilinkResolver): void {
    this.wikilinkResolver = resolver;
  }

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

      case "number": {
        // 숫자로 변환 불가한 값(NaN/Infinity)은 전송하지 않는다. {number: NaN} 은
        // JSON 직렬화 시 null 로 바뀌어 기존 값을 소리 없이 비워버린다.
        const num = typeof value === "number" ? value : Number(value);
        return Number.isFinite(num) ? { number: num } : null;
      }

      case "select": {
        // 빈 이름은 Notion API 가 거부한다. 공백뿐이면 스킵(기존 값 보존).
        const name = String(value);
        return name.trim() ? { select: { name } } : null;
      }

      case "multi_select": {
        const items = Array.isArray(value)
          ? value
          : String(value)
              .split(",")
              .map((s) => s.trim());
        // 빈 옵션 이름 제거 — "a,,b" 나 후행 콤마로 생긴 빈 항목은 Notion 이 거부한다.
        const names = items.map((name: unknown) => String(name)).filter((name) => name.trim());
        return { multi_select: names.map((name) => ({ name })) };
      }

      case "checkbox":
        return { checkbox: Boolean(value) };

      case "date": {
        if (typeof value === "object" && value !== null && "start" in value) {
          const obj = value as { start: string; end?: string | null };
          return { date: { start: obj.start, end: obj.end ?? null } };
        }
        const dateStr = String(value);
        if (DATE_REGEX.test(dateStr)) {
          return { date: { start: dateStr, end: null } };
        }
        return null;
      }

      case "url":
        return { url: String(value) };

      case "email":
        return { email: String(value) };

      case "phone_number":
        return { phone_number: String(value) };

      case "status": {
        // select 와 동일 — 빈 상태 이름은 Notion 이 거부한다.
        const name = String(value);
        return name.trim() ? { status: { name } } : null;
      }

      case "relation": {
        const items = Array.isArray(value) ? value : [value];
        const ids: Array<{ id: string }> = [];
        for (const item of items) {
          const str = String(item);
          const match = str.match(WIKILINK_REGEX);
          if (match?.[1] && this.wikilinkResolver) {
            const pageId = this.wikilinkResolver.resolve(match[1]);
            if (pageId) ids.push({ id: pageId });
          } else if (str.match(/^[0-9a-f-]{32,36}$/)) {
            ids.push({ id: str });
          }
        }
        return ids.length > 0 ? { relation: ids } : null;
      }

      case "people": {
        const users = Array.isArray(value) ? value : [value];
        const peopleArr = users
          .map((u) => {
            const s = String(u);
            if (s.match(/^[0-9a-f-]{32,36}$/)) return { object: "user" as const, id: s };
            return null;
          })
          .filter(Boolean);
        return peopleArr.length > 0 ? { people: peopleArr } : null;
      }

      case "files": {
        const fileList = Array.isArray(value) ? value : [value];
        // 빈 URL 파일 항목은 Notion 이 거부하므로 제거한다(잘못된 첨부 전송 방지).
        const filesArr = fileList
          .map((f) => {
            if (typeof f === "object" && f !== null && "url" in f) {
              const obj = f as { name?: string; url: string };
              const url = String(obj.url ?? "");
              if (!url) return null;
              return { type: "external", name: obj.name ?? "file", external: { url } };
            }
            const url = String(f);
            if (!url) return null;
            return { type: "external", name: url, external: { url } };
          })
          .filter(Boolean);
        return { files: filesArr };
      }

      case "created_time":
      case "last_edited_time":
      case "created_by":
      case "last_edited_by":
      case "formula":
      case "rollup":
      case "unique_id":
      case "verification":
        return null;

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
        return { date: { start: value, end: null } };
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
        const arr = asArray<{ plain_text: string }>(prop.rich_text);
        return arr.map((t) => t.plain_text).join("") || null;
      }
      case "number":
        return prop.number;
      case "select": {
        const sel = prop.select as { name: string } | null;
        return sel?.name ?? null;
      }
      case "multi_select": {
        return asArray<{ name: string }>(prop.multi_select).map((s) => s.name);
      }
      case "checkbox":
        return prop.checkbox;
      case "date": {
        const dateObj = prop.date as { start: string; end?: string | null } | null;
        if (!dateObj) return null;
        if (dateObj.end) return { start: dateObj.start, end: dateObj.end };
        return dateObj.start;
      }
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
        return asArray<{ name?: string; id: string }>(prop.people).map((p) => p.name ?? p.id);
      }
      case "files": {
        const files = asArray<{
          name: string;
          type: string;
          file?: { url: string };
          external?: { url: string };
        }>(prop.files);
        // Obsidian Bases 의 카드 `image:` 는 스칼라 문자열(외부 URL 또는 [[wikilink]])만
        // 렌더한다 — [{name,url}] 객체 배열은 표시되지 않는다. 따라서 URL 문자열로 직렬화한다.
        // 단일 파일 → 스칼라(갤러리 커버 렌더), 복수 → URL 배열(데이터 보존).
        // toNotionProperties 의 files 케이스가 문자열/문자열배열을 모두 받으므로 라운드트립 안전.
        const urls = files
          .map((f) => (f.type === "file" ? f.file?.url : f.external?.url))
          .filter((u): u is string => typeof u === "string" && u.length > 0);
        if (urls.length === 0) return [];
        return urls.length === 1 ? urls[0] : urls;
      }
      case "formula": {
        const formula = prop.formula as { type: string; [k: string]: unknown } | undefined;
        if (!formula) return null;
        return formula[formula.type];
      }
      case "relation": {
        const rel = asArray<{ id: string }>(prop.relation);
        if (rel.length === 0) return [];
        return rel.map((r) => {
          if (this.wikilinkResolver) {
            const title = this.wikilinkResolver.resolvePageId(r.id);
            if (title) return `[[${title}]]`;
          }
          return r.id;
        });
      }
      case "rollup": {
        const rollup = prop.rollup as { type: string; [k: string]: unknown } | undefined;
        if (!rollup) return null;
        if (rollup.type === "array") {
          const arr = asArray<{ type: string; [k: string]: unknown }>(rollup.array);
          return arr.map((item) => this.extractValue(item));
        }
        return rollup[rollup.type] ?? null;
      }
      case "unique_id": {
        const uid = prop.unique_id as { prefix?: string; number?: number } | undefined;
        // number 가 없으면(빈 객체 등) "undefined" 문자열이 새는 것을 막는다.
        if (!uid || typeof uid.number !== "number") return null;
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
