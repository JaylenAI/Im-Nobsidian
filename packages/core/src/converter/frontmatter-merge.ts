import {
  frontmatterLines,
  plainFrontmatterValue,
  sameFrontmatterValue,
  splitFrontmatter,
  type FrontmatterSplit,
} from "../utils/frontmatter.js";

/**
 * 받은 행 속성을 로컬 노트의 frontmatter 에 합친다(F-08).
 *
 * 행 노트의 frontmatter 에는 Notion 속성과 로컬에만 있는 키(`aliases` · `cssclasses` …)가 섞여 있다. 받은
 * 속성으로 frontmatter 를 통째로 다시 쓰면 로컬에만 있는 키가 지워지고, 키 차례와 적은 모양(따옴표 ·
 * `[a, b]` · 주석)이 바뀌어 Notion 에서 속성 하나만 고쳐도 frontmatter 전체가 바뀐다. 그래서:
 *
 * - 키 차례는 로컬 노트를 따른다. 새로 생긴 키는 받은 차례에서 앞에 오는 키 바로 뒤에 넣는다.
 * - Notion 이 정하는 키(`owned`)는 값이 같으면 로컬 줄을 그대로 두고, 다르면 그 자리에서 받은 값으로
 *   바꾸고, 받은 속성에 없으면(값이 비었다) 지운다.
 * - 그 밖의 키는 로컬 줄을 그대로 둔다.
 *
 * 값은 엄격히 견준다 — 예전 버전이 적은 날짜 모양(`…+09:00`)은 같은 순간이어도 받은 모양으로 바뀐다.
 *
 * 로컬 frontmatter 를 키 단위로 나눠 읽을 수 없으면(앵커 · 한 줄에 키 여럿 · CRLF …) 줄은 살리지 않고
 * 값만 합친다 — 차례와 로컬에만 있는 키는 그래도 지킨다.
 *
 * @param localNote 받기 직전의 로컬 노트.
 * @param pulled 받은 속성 — frontmatter 에 적을 값 그대로.
 * @param owned Notion 이 정하는 키. `pulled` 의 키는 모두 Notion 이 정한다.
 * @returns 합친 frontmatter 의 YAML 줄들. 로컬 노트에 읽을 수 있는 frontmatter 가 없으면 null — 받은 대로
 *   쓴다.
 */
export function mergeRowFrontmatter(
  localNote: string,
  pulled: Readonly<Record<string, unknown>>,
  owned: ReadonlySet<string>,
): string[] | null {
  let local: FrontmatterSplit;
  try {
    local = splitFrontmatter(localNote);
  } catch {
    return null;
  }
  if (!local.hasFrontmatter) return null;

  const isOwned = (key: string) => owned.has(key) || Object.hasOwn(pulled, key);
  const order = mergedKeyOrder(Object.keys(local.data), Object.keys(pulled), isOwned);
  const values: Record<string, unknown> = {};
  for (const key of order) {
    values[key] = isOwned(key) ? pulled[key] : plainFrontmatterValue(local.data[key]);
  }

  const chunks = localChunks(localNote, local.data);
  if (chunks !== null) {
    const lines = mergeLines(chunks, order, values, (key) =>
      isOwned(key) ? sameFrontmatterValue(local.data[key], pulled[key]) : true,
    );
    if (readsAs(lines, values)) return lines;
  }
  return frontmatterLines(values);
}

/**
 * 합친 frontmatter 의 키 차례 — 로컬 키는 로컬 차례로(받은 속성에 없는 Notion 키는 뺀다), 받은 속성에만
 * 있는 키는 받은 차례에서 앞에 오는 키 바로 뒤에. 앞에 오는 키가 없으면 받은 키 중 맨 앞에 놓인 것 앞에.
 */
function mergedKeyOrder(
  localKeys: readonly string[],
  pulledKeys: readonly string[],
  isOwned: (key: string) => boolean,
): string[] {
  const pulledSet = new Set(pulledKeys);
  const order = localKeys.filter((key) => !isOwned(key) || pulledSet.has(key));
  let anchor = -1;
  for (const key of pulledKeys) {
    const at = order.indexOf(key);
    if (at !== -1) {
      anchor = at;
      continue;
    }
    const firstPulled = order.findIndex((k) => pulledSet.has(k));
    const insertAt = anchor !== -1 ? anchor + 1 : firstPulled !== -1 ? firstPulled : order.length;
    order.splice(insertAt, 0, key);
    anchor = insertAt;
  }
  return order;
}

/** 로컬 frontmatter 의 맨 위 키 하나와 그 줄들. */
interface Chunk {
  readonly key: string;
  /** 키 줄과 그 값의 줄들. */
  readonly body: readonly string[];
  /** 뒤따르는 빈 줄 · 맨 앞 주석 — 값을 바꿔도 남긴다. */
  readonly trailing: readonly string[];
}

/** 키가 시작하지 않는 줄 — 들여쓴 줄 · 빈 줄 · 주석 · 맨 앞의 목록 항목(`- a`). */
const CONTINUATION_RE = /^(?:[ \t]|#|-(?:[ \t]|$)|$)/;
const TRIVIA_RE = /^(?:#.*|[ \t]*)$/;

/**
 * 로컬 frontmatter 를 맨 위 키 단위로 — 키마다 따로 읽어 노트 전체를 읽은 것과 같을 때만. 첫 키 앞의
 * 주석 · 빈 줄은 `key` 가 빈 조각이다. 나눌 수 없으면 null.
 */
function localChunks(localNote: string, data: Readonly<Record<string, unknown>>): Chunk[] | null {
  const text = localNote.charCodeAt(0) === 0xfeff ? localNote.slice(1) : localNote;
  const lines = text.split("\n");
  const close = lines.findIndex((line, i) => i > 0 && line.startsWith("---"));
  if (close === -1) return null;
  const yaml = lines.slice(1, close);
  if (yaml.some((line) => line.endsWith("\r") || line.startsWith("?"))) return null;

  const groups: string[][] = [[]];
  for (const line of yaml) {
    if (CONTINUATION_RE.test(line)) groups[groups.length - 1]!.push(line);
    else groups.push([line]);
  }

  const chunks: Chunk[] = [];
  const seen: string[] = [];
  for (const [i, group] of groups.entries()) {
    let end = group.length;
    while (end > 0 && TRIVIA_RE.test(group[end - 1]!)) end--;
    if (i === 0) {
      if (end > 0) return null; // 첫 키 앞에 값 줄이 있다 — 맨 위가 키-값이 아니다
      chunks.push({ key: "", body: [], trailing: group });
      continue;
    }
    const body = group.slice(0, end);
    let parsed: Record<string, unknown>;
    try {
      const split = splitFrontmatter(`---\n${body.join("\n")}\n---\n`);
      if (!split.hasFrontmatter) return null;
      parsed = split.data;
    } catch {
      return null;
    }
    const keys = Object.keys(parsed);
    if (keys.length !== 1) return null;
    const key = keys[0]!;
    if (!Object.hasOwn(data, key) || !sameFrontmatterValue(parsed[key], data[key])) return null;
    seen.push(key);
    chunks.push({ key, body, trailing: group.slice(end) });
  }
  const dataKeys = Object.keys(data);
  return seen.length === dataKeys.length && seen.every((key, i) => key === dataKeys[i])
    ? chunks
    : null;
}

/**
 * 로컬 조각을 차례대로 다시 적는다 — 그대로 둘 키는 로컬 줄, 값이 바뀐 키는 받은 값의 줄, 빠진 키는 뒤따르는
 * 빈 줄 · 주석만. 새 키는 차례에서 앞에 오는 로컬 키의 줄 바로 뒤에.
 */
function mergeLines(
  chunks: readonly Chunk[],
  order: readonly string[],
  values: Readonly<Record<string, unknown>>,
  keepsLocalLines: (key: string) => boolean,
): string[] {
  const local = new Map(chunks.filter((c) => c.key !== "").map((c) => [c.key, c]));
  const leading: string[] = [];
  const after = new Map<string, string[]>();
  let last: string | null = null;
  for (const key of order) {
    if (local.has(key)) {
      last = key;
      continue;
    }
    const entry = frontmatterLines({ [key]: values[key] });
    if (last === null) leading.push(...entry);
    else after.set(last, [...(after.get(last) ?? []), ...entry]);
  }

  const kept = new Set(order);
  const lines: string[] = [];
  for (const chunk of chunks) {
    if (chunk.key === "") {
      lines.push(...chunk.trailing, ...leading);
      continue;
    }
    if (kept.has(chunk.key)) {
      lines.push(
        ...(keepsLocalLines(chunk.key)
          ? chunk.body
          : frontmatterLines({ [chunk.key]: values[chunk.key] })),
        ...(after.get(chunk.key) ?? []),
      );
    }
    lines.push(...chunk.trailing);
  }
  return lines;
}

/** 줄들을 frontmatter 로 읽으면 `values` 와 같은 키 차례 · 값인가. */
function readsAs(lines: readonly string[], values: Readonly<Record<string, unknown>>): boolean {
  let data: Record<string, unknown>;
  try {
    const split = splitFrontmatter(`---\n${lines.join("\n")}\n---\n`);
    if (!split.hasFrontmatter) return false;
    data = split.data;
  } catch {
    return false;
  }
  const keys = Object.keys(data);
  const expected = Object.keys(values);
  return (
    keys.length === expected.length &&
    keys.every((key, i) => key === expected[i] && sameFrontmatterValue(data[key], values[key]))
  );
}
