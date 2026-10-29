/**
 * 볼트에서 만든 노트 폴더를 Notion DB 로 올릴 준비 (#75).
 *
 * push 는 사이드카(`<DB>.notion.json`)가 있는 새 폴더를 Notion DB 로 만든다(ADR-036). 사이드카는 pull 이 쓰므로,
 * 볼트에서 처음 만든 폴더(Obsidian Bases 로 보던 노트 묶음)에는 없다 — 그런 폴더는 페이지 묶음으로 올라갔다.
 * 여기서 노트의 frontmatter 와 폴더의 `.base` 로 사이드카를 만들어 둔다. 그 뒤는 ADR-036 의 길 그대로다.
 *
 * 스키마는 추정이다 — 사이드카는 사람이 읽는 JSON 이라 push 전에 고칠 수 있다. 무엇을 왜 그렇게 정했는지
 * 보고서로 돌려준다(ADR-037).
 */
import { OPTION_NAME_MAX } from "../constants/notion-limits.js";
import { DECORATION_KEYS } from "../notion/decoration-values.js";
import { isFrontmatterDate, RANGE_END_SUFFIX } from "../notion/property-mapper.js";
import type { IStateDB } from "../state/state-db-interface.js";
import { isDirectDbRowPath } from "../utils/db-folder-path.js";
import {
  isEmptyFrontmatterValue,
  parseFrontmatter,
  plainFrontmatterValue,
} from "../utils/frontmatter.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import type { BasesViewType } from "../view/base-file-generator.js";
import { BASE_SUFFIX, OBSIDIAN_CONFIG_DIR, SIDECAR_SUFFIX } from "../constants/paths.js";
import { DEFAULT_TITLE_PROPERTY } from "../types/config.js";
import {
  SIDECAR_GENERATOR,
  SIDECAR_SCHEMA_VERSION,
  SidecarGenerator,
  type NotionSidecar,
  type SidecarProperty,
  type SidecarView,
} from "../view/sidecar-generator.js";
import type { VaultFS } from "./vault-fs.js";
import { BASES_TITLE } from "../view/bases-file-properties.js";

/** 폴더의 노트 하나 — 볼트 경로와 읽은 frontmatter. */
export interface FolderNote {
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

/** 속성 하나를 어떻게 정했나. */
export interface InferredProperty {
  readonly name: string;
  readonly type: string;
  /** 사람이 읽는 까닭 — `Obsidian 속성 타입 number` · `값 12개가 모두 날짜` … */
  readonly reason: string;
}

export interface FolderDatabaseDraft {
  readonly sidecar: NotionSidecar;
  readonly properties: readonly InferredProperty[];
  /** 옮긴 보기 이름. */
  readonly views: readonly string[];
  /** 옮기지 않은 것과 까닭 — 키 · 보기 · 필터. */
  readonly skipped: ReadonlyArray<{ readonly what: string; readonly reason: string }>;
}

export interface FolderDatabaseReport extends FolderDatabaseDraft {
  readonly folder: string;
  readonly sidecarPath: string;
  readonly rows: number;
}

/** 속성이 아닌 frontmatter 키 — Obsidian 의 것이거나 페이지의 꾸밈 · 제목이다. */
const NON_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  "title",
  "aliases",
  "alias",
  "cssclasses",
  "cssclass",
  ...DECORATION_KEYS,
]);

/**
 * 글 값을 select 로 볼 문턱 — 같은 값이 되풀이되고, 값의 가짓수가 적고 짧아야 한다. 아니면 글(rich_text)이다.
 * 고르기는 나중에 글로 바꿔도 값이 남지만, 글을 고르기로 잘못 정하면 옵션이 값 수만큼 생긴다.
 */
const SELECT_MAX_OPTIONS = 25;
const SELECT_MAX_LENGTH = 50;

/** Obsidian 속성 타입(`.obsidian/types.json`) → Notion 속성 타입. `text` 는 값을 보고 정한다. */
const OBSIDIAN_TYPES: Readonly<Record<string, string | null>> = {
  number: "number",
  checkbox: "checkbox",
  date: "date",
  datetime: "date",
  multitext: "multi_select",
  tags: "multi_select",
  aliases: null,
};

/** `.base` 보기 타입 → Notion 보기 타입. */
const BASES_VIEW_TYPES: Readonly<Record<BasesViewType, string>> = {
  table: "table",
  cards: "gallery",
  list: "list",
};

const URL_RE = /^https?:\/\/\S+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WIKILINK_RE = /^\[\[[^[\]]+\]\]$/;

/**
 * 노트들의 frontmatter 와 `.base` 로 사이드카를 만든다 — I/O 없음.
 *
 * @param databaseId 사이드카에 적을 DB id. 받아 온 DB 가 없으므로 새로 지은 것이다 — push 는 이 id 의 DB 에
 *   쓰지 않고 새 DB 를 만들어 짝을 적는다(ADR-036 결정 3).
 * @param declaredTypes Obsidian 이 속성마다 정해 둔 타입(`types.json` 의 `types`).
 */
export function draftFolderDatabase(input: {
  readonly title: string;
  readonly databaseId: string;
  readonly notes: readonly FolderNote[];
  readonly base?: string;
  readonly declaredTypes?: Readonly<Record<string, string>>;
}): FolderDatabaseDraft {
  const skipped: Array<{ what: string; reason: string }> = [];
  const values = collectValues(input.notes);
  const inferred: InferredProperty[] = [];
  const properties: SidecarProperty[] = [
    { name: DEFAULT_TITLE_PROPERTY, id: "title", type: "title" },
  ];

  let index = 0;
  for (const [name, list] of values) {
    if (NON_PROPERTY_KEYS.has(name)) continue;
    if (isRangeEnd(name, values)) continue;
    if (name === DEFAULT_TITLE_PROPERTY) {
      skipped.push({ what: name, reason: "제목 속성과 이름이 같다 — 이름을 바꾸면 속성이 된다" });
      continue;
    }
    const decided = decideType(list, input.declaredTypes?.[name]);
    if (!decided) {
      skipped.push({ what: name, reason: "Obsidian 별칭 속성이다" });
      continue;
    }
    const property: SidecarProperty = {
      name,
      id: `p${index++}`,
      type: decided.type,
      ...(decided.options
        ? { definition: { options: decided.options.map((o) => ({ name: o })) } }
        : {}),
      ...(decided.options ? { options: decided.options } : {}),
    };
    properties.push(property);
    inferred.push({ name, type: decided.type, reason: decided.reason });
  }

  const views = input.base === undefined ? [] : viewsOf(input.base, properties, skipped);
  return {
    sidecar: {
      generator: SIDECAR_GENERATOR,
      schemaVersion: SIDECAR_SCHEMA_VERSION,
      databaseId: input.databaseId,
      databaseName: input.title,
      isInline: false,
      // pull 이 쓰는 사이드카와 같은 차례 — 이름 정렬.
      properties: [...properties].sort((a, b) => a.name.localeCompare(b.name)),
      views,
      degraded: [],
    },
    properties: inferred,
    views: views.map((v) => v.name),
    skipped,
  };
}

/**
 * 볼트 폴더를 Notion DB 로 올릴 준비 — 사이드카를 써 둔다. 다음 push 가 DB 를 만들고 노트를 행으로 올린다.
 *
 * 거절하는 것: 노트가 없는 폴더, 이미 사이드카가 있는 폴더(pull 이 받은 DB 이거나 이미 준비했다), 노트가
 * 이미 Notion 에 올라간 폴더 — push 는 이미 있는 페이지를 DB 의 행으로 옮기지 않는다.
 */
export async function prepareFolderDatabase(
  vaultFs: VaultFS,
  stateDb: IStateDB,
  folder: string,
  options: { readonly databaseId: string; readonly configDir?: string },
): Promise<FolderDatabaseReport> {
  const trimmed = folder.replace(/^\/+|\/+$/g, "");
  if (!trimmed) throw new Error("볼트 맨 위는 DB 로 바꿀 수 없다 — 폴더를 고르세요");

  const notePaths = (await vaultFs.listMarkdownFiles())
    .map((f) => f.path)
    .filter((p) => isDirectDbRowPath(trimmed, p))
    .sort();
  if (notePaths.length === 0) throw new Error(`폴더 바로 아래에 노트가 없다: ${trimmed}`);

  const direct = (await vaultFs.listNonMarkdownFiles())
    .map((f) => f.path)
    .filter((p) => isDirectDbRowPath(trimmed, p));
  const sidecar = direct.find((p) => p.endsWith(SIDECAR_SUFFIX));
  if (sidecar) throw new Error(`이미 DB 사이드카가 있다: ${sidecar}`);

  const synced = notePaths.filter((p) => stateDb.getByPath(p)?.notionPageId);
  if (synced.length > 0) {
    throw new Error(
      `노트 ${synced.length}개가 이미 Notion 페이지로 올라가 있다 — push 는 있는 페이지를 DB 의 행으로 옮기지 않는다 (${synced[0]} …)`,
    );
  }

  const notes: FolderNote[] = [];
  for (const path of notePaths) {
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseFrontmatter(await vaultFs.readFile(path)).data;
    } catch (error) {
      throw new Error(
        `frontmatter 를 읽지 못함 (${path}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    notes.push({ path, frontmatter });
  }

  // `.base` 가 하나면 그 이름이 DB 제목이다 — 부모 노트의 `![[이름.base]]` 가 사이드카로 새 DB 를 찾는다.
  const bases = direct.filter((p) => p.endsWith(BASE_SUFFIX)).sort();
  const basePath = bases.length === 1 ? bases[0] : undefined;
  const folderName = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const title = basePath
    ? basePath.slice(basePath.lastIndexOf("/") + 1, -BASE_SUFFIX.length)
    : folderName;
  const base = basePath ? await vaultFs.readFile(basePath).catch(() => undefined) : undefined;

  const draft = draftFolderDatabase({
    title,
    databaseId: options.databaseId,
    notes,
    ...(base === undefined ? {} : { base }),
    declaredTypes: await readDeclaredTypes(vaultFs, options.configDir ?? OBSIDIAN_CONFIG_DIR),
  });
  const extra =
    bases.length > 1
      ? [
          {
            what: "보기",
            reason: `.base 가 ${bases.length}개라 보기를 옮기지 않았다 — 하나만 두세요`,
          },
        ]
      : [];

  const sidecarPath = `${trimmed}/${sanitizeFileName(title)}${SIDECAR_SUFFIX}`;
  await vaultFs.writeFile(sidecarPath, new SidecarGenerator().serialize(draft.sidecar));
  return {
    ...draft,
    skipped: [...draft.skipped, ...extra],
    folder: trimmed,
    sidecarPath,
    rows: notes.length,
  };
}

/** Obsidian 이 속성마다 정해 둔 타입. 읽지 못하면 없다고 본다 — 값으로 정한다. */
async function readDeclaredTypes(
  vaultFs: VaultFS,
  configDir: string,
): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await vaultFs.readFile(`${configDir}/types.json`)) as {
      types?: unknown;
    };
    if (!parsed.types || typeof parsed.types !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed.types as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** 키마다 비어 있지 않은 값 — 처음 나온 키 차례대로. */
function collectValues(notes: readonly FolderNote[]): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  for (const note of notes) {
    for (const [key, raw] of Object.entries(note.frontmatter)) {
      const value = plainFrontmatterValue(raw);
      const list = out.get(key) ?? [];
      if (!isEmptyFrontmatterValue(value)) list.push(value);
      out.set(key, list);
    }
  }
  return out;
}

/** 기간의 끝을 적는 짝 키 — 시작 키가 날짜면 그 속성의 일부다. */
function isRangeEnd(name: string, values: ReadonlyMap<string, unknown[]>): boolean {
  if (!name.endsWith(RANGE_END_SUFFIX)) return false;
  const start = values.get(name.slice(0, -RANGE_END_SUFFIX.length));
  return start !== undefined && start.length > 0 && start.every(isFrontmatterDate);
}

function decideType(
  values: readonly unknown[],
  declared: string | undefined,
): { type: string; reason: string; options?: string[] } | null {
  const mapped = declared === undefined ? undefined : OBSIDIAN_TYPES[declared];
  if (mapped === null) return null;
  if (mapped === "multi_select") return listType(values, `Obsidian 속성 타입 ${declared}`);
  if (mapped) return { type: mapped, reason: `Obsidian 속성 타입 ${declared}` };

  const n = values.length;
  if (n === 0) return { type: "rich_text", reason: "값이 없다" };
  const all = (test: (v: unknown) => boolean) => values.every(test);
  if (all((v) => typeof v === "boolean"))
    return { type: "checkbox", reason: `값 ${n}개가 모두 참/거짓` };
  if (all((v) => typeof v === "number")) return { type: "number", reason: `값 ${n}개가 모두 수` };
  if (all(isFrontmatterDate)) return { type: "date", reason: `값 ${n}개가 모두 날짜` };
  if (all(Array.isArray)) return listType(values, `값 ${n}개가 모두 목록`);
  if (all((v) => typeof v === "string" && URL_RE.test(v)))
    return { type: "url", reason: `값 ${n}개가 모두 웹 주소` };
  if (all((v) => typeof v === "string" && EMAIL_RE.test(v)))
    return { type: "email", reason: `값 ${n}개가 모두 메일 주소` };
  if (all((v) => typeof v === "string" && WIKILINK_RE.test(v)))
    return { type: "rich_text", reason: "노트 링크 — 대상 DB 를 알 수 없어 글로 보낸다" };

  const texts = values.map((v) => String(v));
  const distinct = [...new Set(texts)];
  const repeated = distinct.length < texts.length;
  if (
    repeated &&
    distinct.length <= SELECT_MAX_OPTIONS &&
    distinct.every((t) => t.length <= SELECT_MAX_LENGTH && optionName(t))
  ) {
    return {
      type: "select",
      reason: `값 ${n}개가 ${distinct.length}가지로 되풀이된다`,
      options: distinct,
    };
  }
  return { type: "rich_text", reason: "글" };
}

/** 목록 값 — 항목이 모두 옵션 이름이 될 수 있으면 multi_select, 아니면 글. */
function listType(
  values: readonly unknown[],
  reason: string,
): { type: string; reason: string; options?: string[] } {
  const items = values.flatMap((v) => (Array.isArray(v) ? v : [v])).map((v) => String(v));
  const distinct = [...new Set(items)];
  if (!distinct.every(optionName)) {
    return { type: "rich_text", reason: `${reason} — 쉼표가 들었거나 긴 항목이 있어 글로` };
  }
  return { type: "multi_select", reason, options: distinct };
}

function optionName(text: string): boolean {
  return text.length > 0 && text.length <= OPTION_NAME_MAX && !text.includes(",");
}

/**
 * `.base` 의 보기를 사이드카 보기로 — 표 · 카드 · 목록의 이름 · 열 차례 · 정렬. 필터 · 수식 열은 Notion 보기로
 * 옮기지 않는다(Bases 식을 Notion 필터로 바꿀 수 없다).
 */
function viewsOf(
  text: string,
  properties: readonly SidecarProperty[],
  skipped: Array<{ what: string; reason: string }>,
): SidecarView[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseFrontmatter(`---\n${text}\n---\n`).data;
  } catch {
    skipped.push({ what: "보기", reason: ".base 를 읽지 못했다" });
    return [];
  }
  const idOf = new Map<string, string>();
  for (const p of properties) idOf.set(p.type === "title" ? BASES_TITLE : p.name, p.id);
  const columnId = (raw: unknown): string | undefined => {
    if (typeof raw !== "string") return undefined;
    return idOf.get(raw) ?? idOf.get(raw.replace(/^note\./, ""));
  };

  const views: SidecarView[] = [];
  const list = Array.isArray(parsed.views) ? (parsed.views as Array<Record<string, unknown>>) : [];
  list.forEach((view, i) => {
    const name = typeof view.name === "string" && view.name.trim() ? view.name : `보기 ${i + 1}`;
    const basesType = view.type as BasesViewType;
    const type = Object.hasOwn(BASES_VIEW_TYPES, basesType)
      ? BASES_VIEW_TYPES[basesType]
      : undefined;
    if (!type) {
      skipped.push({
        what: `보기 ${name}`,
        reason: `Notion 에 없는 보기 타입(${String(view.type)})`,
      });
      return;
    }
    if (view.filters !== undefined) {
      skipped.push({
        what: `보기 ${name} 의 필터`,
        reason: "Bases 식은 Notion 필터로 바꾸지 못한다",
      });
    }
    const order = Array.isArray(view.order) ? view.order : [];
    const columns = order.map(columnId).filter((id): id is string => id !== undefined);
    const dropped = order.filter((raw) => columnId(raw) === undefined);
    if (dropped.length > 0) {
      skipped.push({
        what: `보기 ${name} 의 열`,
        reason: `DB 속성이 아니다: ${dropped.join(", ")}`,
      });
    }
    const sorts = (Array.isArray(view.sort) ? (view.sort as Array<Record<string, unknown>>) : [])
      .map((s) => ({ id: columnId(s.property), direction: s.direction }))
      .filter((s): s is { id: string; direction: unknown } => s.id !== undefined)
      .map((s) => ({
        property: s.id,
        direction: String(s.direction).toUpperCase() === "DESC" ? "descending" : "ascending",
      }));
    views.push({
      id: `v${i}`,
      name,
      notionType: type,
      basesType,
      config: {
        configuration: {
          type,
          properties: columns.map((id) => ({ property_id: id, visible: true })),
        },
        ...(sorts.length > 0 ? { sorts } : {}),
      },
    });
  });
  return views;
}
