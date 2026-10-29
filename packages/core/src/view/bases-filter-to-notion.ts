import type { BasePropertySchema } from "../types/view.js";
import { RELATIVE_DATE_RANGES, RELATIVE_DATE_VALUES } from "./relative-dates.js";
import { decodePropertyId } from "./property-resolver.js";
import { BASES_TITLE, notionTimestampOf } from "./bases-file-properties.js";

/**
 * Bases 보기 필터 → Notion 보기 필터 — `notion-filter-translator.ts` 의 반대 방향(P4 · ADR-046).
 *
 * 볼트에서 고친 `.base` 의 필터를 Notion 보기에 올릴 때 쓴다. Bases 식은 Notion 필터보다 훨씬 넓다(수식 · 함수 ·
 * 산술). 그래서 **아는 꼴만** 옮긴다 — pull 이 쓰는 꼴과 Obsidian 필터 화면이 쓰는 꼴(1.12 · 1.13 실측):
 *
 *   - 속성: `점수` · `note.점수` · `note["마감 일"]` · `file.name`(제목) · `file.ctime` · `file.mtime`
 *   - 비교: `== != > < >= <=` 와 문자열 · 숫자 · `true`/`false` · 날짜(`"2026-10-29"` · `date("…")`) · 상대 날짜
 *     (`today()` · `today() - "7d"` …, `.date()` 를 붙여도 된다)
 *   - 함수: `contains` · `startsWith` · `endsWith` · `containsAny` · `isEmpty`, 앞에 `!`
 *   - 묶음: YAML `and` · `or` · `not` 과 식 안의 `&&` · `||` · 괄호
 *
 * 하나라도 모르는 꼴이면 필터 전체를 옮기지 않는다 — 일부만 보내면 Notion 보기가 볼트와 다른 행을 고른다.
 */

/** Notion 보기 필터 한 덩어리. */
export type NotionFilter = Record<string, unknown>;

export type FilterConversion =
  | { readonly ok: true; readonly filter: NotionFilter }
  | { readonly ok: false; readonly error: string };

/** Notion 필터는 묶음을 두 겹까지만 받는다(API 문서 · compound filter). */
const MAX_FILTER_DEPTH = 2;

const TEXT_TYPES: ReadonlySet<string> = new Set([
  "title",
  "rich_text",
  "url",
  "email",
  "phone_number",
]);

/** 빈 값 조건(`is_empty`)을 받는 Notion 필터 타입. */
const EMPTY_TYPES: ReadonlySet<string> = new Set([
  ...TEXT_TYPES,
  "number",
  "select",
  "status",
  "multi_select",
  "date",
]);

/** Bases 비교 기호 → Notion 연산자(숫자 · 날짜). */
const NUMBER_OPS: Readonly<Record<string, string>> = {
  "==": "equals",
  "!=": "does_not_equal",
  ">": "greater_than",
  "<": "less_than",
  ">=": "greater_than_or_equal_to",
  "<=": "less_than_or_equal_to",
};
const DATE_OPS: Readonly<Record<string, string>> = {
  "==": "equals",
  "<": "before",
  ">": "after",
  "<=": "on_or_before",
  ">=": "on_or_after",
};

/** Bases 상대 날짜 식(공백 없앤 꼴) → Notion 상대 날짜 값. `RELATIVE_DATE_VALUES` 를 거꾸로 읽는다. */
const RELATIVE_VALUE_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(RELATIVE_DATE_VALUES).map(([value, expr]) => [squash(expr), value]),
);

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

/**
 * `.base` 보기의 `filters` 값을 Notion 필터로. 속성은 `schema`(이름 → id · 타입)에서 찾는다 — 볼트 행 노트의 키가
 * 곧 Notion 속성 이름이다.
 */
export function basesFilterToNotion(
  node: unknown,
  schema: Readonly<Record<string, BasePropertySchema>>,
): FilterConversion {
  try {
    const filter = settle([toFilter(node, schema)])[0]!;
    if (depthOf(filter) > MAX_FILTER_DEPTH) {
      refuse("Notion 필터는 and · or 묶음을 두 겹까지만 받습니다");
    }
    return { ok: true, filter };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.message };
    throw error;
  }
}

// ─── YAML 묶음 ───

function toFilter(
  node: unknown,
  schema: Readonly<Record<string, BasePropertySchema>>,
): NotionFilter {
  if (typeof node === "string") return compile(parseExpression(node), schema);
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    refuse("필터는 식 하나이거나 and · or · not 묶음이어야 합니다");
  }
  const group = node as Partial<Record<"and" | "or" | "not", unknown>>;
  const keys = Object.keys(group);
  if (keys.length !== 1 || !["and", "or", "not"].includes(keys[0]!)) {
    refuse(`필터 묶음은 and · or · not 중 하나여야 합니다(${keys.join(", ")})`);
  }
  const op = keys[0] as "and" | "or" | "not";
  const children = group[op];
  if (!Array.isArray(children) || children.length === 0) refuse(`${op} 묶음이 비어 있습니다`);
  const asts: Ast[] = children.map((child) =>
    typeof child === "string" ? parseExpression(child) : { kind: "yaml", node: child },
  );
  // Bases 의 not 은 «하나도 맞지 않는다» — 부정한 것들의 and 다.
  const ast: Ast =
    op === "not"
      ? { kind: "and", items: asts.map((item) => ({ kind: "not", item })) }
      : { kind: op, items: asts };
  return compile(ast, schema);
}

// ─── 식 → 구문 트리 ───

type Ast =
  | { readonly kind: "and" | "or"; readonly items: readonly Ast[] }
  | { readonly kind: "not"; readonly item: Ast }
  | { readonly kind: "yaml"; readonly node: unknown }
  | { readonly kind: "compare"; readonly op: string; readonly left: Term; readonly right: Term }
  | {
      readonly kind: "call";
      readonly target: Term;
      readonly name: string;
      readonly args: readonly Term[];
    };

type Term =
  | { readonly kind: "ref"; readonly ref: Ref }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  /** 날짜 식(`today()` · `today() - "7d"` · `date("…")`) — 공백을 없앤 원문. */
  | { readonly kind: "date"; readonly text: string; readonly literal?: string };

/** 속성 참조 — 노트 속성 이름이거나 파일 속성. `.date()` 를 붙였는지. */
interface Ref {
  readonly scope: "note" | "file";
  readonly name: string;
  readonly dateOnly: boolean;
}

type Token =
  | { readonly t: "ident"; readonly v: string }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly v: number }
  | { readonly t: "op"; readonly v: string };

const OPERATORS = [
  "&&",
  "||",
  "==",
  "!=",
  ">=",
  "<=",
  ">",
  "<",
  "!",
  "+",
  "-",
  "(",
  ")",
  "[",
  "]",
  ".",
  ",",
];

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let value = "";
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        value += text[i];
        i++;
      }
      if (i >= text.length) refuse(`따옴표가 닫히지 않았습니다: ${text}`);
      i++;
      tokens.push({ t: "string", v: value });
      continue;
    }
    const number = /^\d+(?:\.\d+)?/.exec(text.slice(i));
    if (number) {
      tokens.push({ t: "number", v: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) {
      tokens.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    const ident = /^[\p{L}\p{N}_]+/u.exec(text.slice(i));
    if (ident) {
      tokens.push({ t: "ident", v: ident[0] });
      i += ident[0].length;
      continue;
    }
    refuse(`필터 식을 읽지 못했습니다: ${text}`);
  }
  return tokens;
}

function parseExpression(text: string): Ast {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = (v?: string): Token | undefined => {
    const token = tokens[pos];
    return v === undefined || (token?.t === "op" && token.v === v) ? token : undefined;
  };
  const take = (v: string): boolean => {
    if (!peek(v)) return false;
    pos++;
    return true;
  };
  const expect = (v: string): void => {
    if (!take(v)) refuse(`필터 식에서 '${v}' 가 와야 합니다: ${text}`);
  };

  const orExpr = (): Ast => {
    const items = [andExpr()];
    while (take("||")) items.push(andExpr());
    return items.length === 1 ? items[0]! : { kind: "or", items };
  };
  const andExpr = (): Ast => {
    const items = [unary()];
    while (take("&&")) items.push(unary());
    return items.length === 1 ? items[0]! : { kind: "and", items };
  };
  const unary = (): Ast => {
    if (take("!")) return { kind: "not", item: unary() };
    if (peek("(")) {
      // 괄호 묶음 — 비교의 왼쪽일 수는 없다(우리가 옮기는 꼴에서는 속성이 왼쪽이다).
      pos++;
      const inner = orExpr();
      expect(")");
      return inner;
    }
    return comparison();
  };
  const comparison = (): Ast => {
    const left = operand();
    const op = tokens[pos];
    if (op?.t === "op" && ["==", "!=", ">", "<", ">=", "<="].includes(op.v)) {
      if (left.call) refuse(`함수 결과를 견주는 식은 옮기지 않습니다: ${text}`);
      pos++;
      return { kind: "compare", op: op.v, left: left.term, right: operand().term };
    }
    if (left.call) return left.call;
    refuse(`비교나 함수 호출이 아닌 식은 옮기지 않습니다: ${text}`);
  };
  /** 값 하나 — 속성 참조(뒤에 `.함수(…)` 가 붙을 수 있다) · 문자열 · 숫자 · 날짜 식. */
  const operand = (): { term: Term; call?: Ast } => {
    const token = tokens[pos];
    if (!token) refuse(`필터 식이 덜 끝났습니다: ${text}`);
    if (token.t === "string") {
      pos++;
      return { term: { kind: "string", value: token.v } };
    }
    if (token.t === "number") {
      pos++;
      return { term: { kind: "number", value: token.v } };
    }
    if (token.t === "ident" && (token.v === "true" || token.v === "false")) {
      pos++;
      return { term: { kind: "boolean", value: token.v === "true" } };
    }
    if (
      token.t === "ident" &&
      (token.v === "today" || token.v === "date") &&
      tokens[pos + 1]?.v === "("
    ) {
      return { term: dateTerm() };
    }
    if (token.t === "ident") return reference();
    refuse(`필터 식을 읽지 못했습니다: ${text}`);
  };
  /** `today()` · `today() ± "Nd"` · `date("2026-10-29")`. */
  const dateTerm = (): Term => {
    const start = pos;
    const fn = (tokens[pos] as { v: string }).v;
    pos += 2;
    let literal: string | undefined;
    if (fn === "date") {
      const arg = tokens[pos];
      if (arg?.t !== "string") refuse(`date() 에는 날짜 문자열을 넣어야 합니다: ${text}`);
      literal = arg.v;
      pos++;
    }
    expect(")");
    if (fn === "today" && (peek("+") || peek("-")) && tokens[pos + 1]?.t === "string") pos += 2;
    const raw = tokens
      .slice(start, pos)
      .map((t) => (t.t === "string" ? JSON.stringify(t.v) : String(t.v)))
      .join("");
    return { kind: "date", text: raw, ...(literal !== undefined ? { literal } : {}) };
  };
  /** `이름` · `note.이름` · `note["이름"]` · `file.ctime`, 뒤에 `.date()` 나 `.함수(인자…)`. */
  const reference = (): { term: Term; call?: Ast } => {
    const head = (tokens[pos++] as { v: string }).v;
    let ref: Ref;
    if ((head === "note" || head === "file") && (peek(".") || peek("["))) {
      let name: string;
      if (take("[")) {
        const key = tokens[pos++];
        if (key?.t !== "string") refuse(`${head}[…] 에는 문자열 이름을 넣어야 합니다: ${text}`);
        name = key.v;
        expect("]");
      } else {
        pos++;
        const key = tokens[pos++];
        if (key?.t !== "ident") refuse(`${head}. 뒤에 이름이 와야 합니다: ${text}`);
        name = key.v;
      }
      ref = { scope: head, name, dateOnly: false };
    } else if (head === "formula" || head === "this") {
      refuse(`${head} 는 Notion 속성이 아니라 옮기지 않습니다: ${text}`);
    } else {
      ref = { scope: "note", name: head, dateOnly: false };
    }
    while (take(".")) {
      const method = tokens[pos++];
      if (method?.t !== "ident") refuse(`'.' 뒤에 함수 이름이 와야 합니다: ${text}`);
      expect("(");
      const args: Term[] = [];
      if (!take(")")) {
        do args.push(operand().term);
        while (take(","));
        expect(")");
      }
      if (method.v === "date" && args.length === 0 && !ref.dateOnly) {
        ref = { ...ref, dateOnly: true };
        continue;
      }
      if (peek(".")) refuse(`함수를 이어 부른 식은 옮기지 않습니다: ${text}`);
      return {
        term: { kind: "ref", ref },
        call: { kind: "call", target: { kind: "ref", ref }, name: method.v, args },
      };
    }
    return { term: { kind: "ref", ref } };
  };

  const ast = orExpr();
  if (pos !== tokens.length) refuse(`필터 식 끝에 읽지 못한 것이 있습니다: ${text}`);
  return ast;
}

// ─── 구문 트리 → Notion 필터 ───

interface Target {
  /** 필터 리프의 머리 — `{ property: id }` 또는 `{ timestamp: "created_time" }`. */
  readonly head: Record<string, string>;
  /** Notion 필터의 타입 키. */
  readonly type: string;
  readonly label: string;
}

function compile(ast: Ast, schema: Readonly<Record<string, BasePropertySchema>>): NotionFilter {
  switch (ast.kind) {
    case "yaml":
      return toFilter(ast.node, schema);
    case "and":
    case "or":
      return group(
        ast.kind,
        ast.items.map((item) => compile(item, schema)),
      );
    case "not":
      return negate(compile(ast.item, schema));
    case "compare":
      return compare(ast, schema);
    case "call":
      return call(ast, schema);
  }
}

/** and · or 묶음. and 안의 상대 기간 두 끝(`>= today() - "7d"` · `<= today()`)은 Notion 의 `past_week` 하나로 모은다. */
function group(op: "and" | "or", items: NotionFilter[]): NotionFilter {
  const merged = settle(op === "and" ? mergeRelativeRanges(items) : items);
  return merged.length === 1 ? merged[0]! : { [op]: merged };
}

/**
 * 짝을 찾지 못한 상대 날짜 끝을 정리한다 — 값이 상대 날짜 값(`one_week_ago` …)이면 그 조건으로 두고, 아니면
 * (`today() - "1y"`) Notion 에 같은 값이 없어 거절한다.
 */
function settle(items: NotionFilter[]): NotionFilter[] {
  return items.map((item) => {
    if (!isPendingRange(item)) return item;
    const { pending, ...leaf } = item;
    if (Object.keys(leaf).length === 0) {
      refuse(`상대 기간 '${pending.text}' 은 반대쪽 끝(today())과 and 로 짝을 이뤄야 옮깁니다`);
    }
    return leaf;
  });
}

function compare(
  ast: Extract<Ast, { kind: "compare" }>,
  schema: Readonly<Record<string, BasePropertySchema>>,
): NotionFilter {
  if (ast.left.kind !== "ref") refuse("비교의 왼쪽은 속성이어야 합니다");
  const target = targetOf(ast.left.ref, schema);
  const value = ast.right;
  const leaf = (op: string, v: unknown): NotionFilter => ({
    ...target.head,
    [target.type]: { [op]: v },
  });

  if (TEXT_TYPES.has(target.type) || target.type === "select" || target.type === "status") {
    if (value.kind !== "string") refuse(`${target.label}: 문자열과만 견줄 수 있습니다`);
    if (ast.op === "==") return leaf("equals", value.value);
    if (ast.op === "!=") return leaf("does_not_equal", value.value);
    refuse(`${target.label}: '${ast.op}' 로는 견주지 못합니다`);
  }
  if (target.type === "number") {
    if (value.kind !== "number") refuse(`${target.label}: 숫자와만 견줄 수 있습니다`);
    return leaf(NUMBER_OPS[ast.op]!, value.value);
  }
  if (target.type === "checkbox") {
    if (value.kind !== "boolean") refuse(`${target.label}: true · false 와만 견줄 수 있습니다`);
    if (ast.op === "==") return leaf("equals", value.value);
    if (ast.op === "!=") return leaf("does_not_equal", value.value);
    refuse(`${target.label}: '${ast.op}' 로는 견주지 못합니다`);
  }
  if (
    target.type === "date" ||
    target.type === "created_time" ||
    target.type === "last_edited_time"
  ) {
    const op = DATE_OPS[ast.op];
    if (!op) refuse(`${target.label}: 날짜는 '${ast.op}' 로 견주지 못합니다`);
    return dateLeaf(target, op, ast.op, value);
  }
  refuse(`${target.label}: ${target.type} 속성의 필터는 옮기지 않습니다`);
}

/** 날짜 비교 — 절대 날짜 · 상대 날짜 값. 상대 기간의 한 끝이면 짝을 찾을 때까지 남겨 둔다. */
function dateLeaf(target: Target, op: string, symbol: string, value: Term): NotionFilter {
  const leaf = (v: string): NotionFilter => ({ ...target.head, [target.type]: { [op]: v } });
  if (value.kind === "string") {
    if (!/^\d{4}-\d{2}-\d{2}/.test(value.value))
      refuse(`${target.label}: 날짜가 아닌 값 '${value.value}'`);
    return leaf(value.value);
  }
  if (value.kind !== "date") refuse(`${target.label}: 날짜와만 견줄 수 있습니다`);
  if (value.literal !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(value.literal))
      refuse(`${target.label}: 날짜가 아닌 값 '${value.literal}'`);
    return leaf(value.literal);
  }
  const pending: PendingRange = { target, symbol, text: value.text };
  const relative = RELATIVE_VALUE_OF.get(value.text);
  return relative === undefined ? { pending } : { ...leaf(relative), pending };
}

function call(
  ast: Extract<Ast, { kind: "call" }>,
  schema: Readonly<Record<string, BasePropertySchema>>,
): NotionFilter {
  if (ast.target.kind !== "ref") refuse("함수는 속성에 붙여야 합니다");
  const target = targetOf(ast.target.ref, schema);
  const leaf = (op: string, v: unknown): NotionFilter => ({
    ...target.head,
    [target.type]: { [op]: v },
  });
  const strings = ast.args.map((arg) => {
    if (arg.kind !== "string") refuse(`${target.label}: ${ast.name}() 에는 문자열을 넣어야 합니다`);
    return arg.value;
  });

  if (ast.name === "isEmpty" && strings.length === 0) {
    if (!EMPTY_TYPES.has(target.type)) refuse(`${target.label}: 빈 값 조건은 옮기지 않습니다`);
    return leaf("is_empty", true);
  }
  if (TEXT_TYPES.has(target.type) && strings.length === 1) {
    if (ast.name === "contains") return leaf("contains", strings[0]);
    if (ast.name === "startsWith") return leaf("starts_with", strings[0]);
    if (ast.name === "endsWith") return leaf("ends_with", strings[0]);
  }
  if (target.type === "multi_select" && strings.length > 0) {
    if (ast.name === "containsAny" || (ast.name === "contains" && strings.length === 1)) {
      // Notion 의 contains 는 값 하나 — 여럿이면 or 로 묶는다.
      const parts = strings.map((s) => leaf("contains", s));
      return parts.length === 1 ? parts[0]! : { or: parts };
    }
  }
  refuse(`${target.label}: ${ast.name}() 은 옮기지 않습니다`);
}

/** 부정 — Notion 에는 not 이 없어 연산자를 뒤집는다. 뒤집을 수 없는 조건(크기 비교 · 날짜)은 옮기지 않는다. */
function negate(filter: NotionFilter): NotionFilter {
  if (isPendingRange(filter)) refuse("상대 기간 조건의 부정은 옮기지 않습니다");
  if (Array.isArray(filter["and"])) return { or: (filter["and"] as NotionFilter[]).map(negate) };
  if (Array.isArray(filter["or"])) return { and: (filter["or"] as NotionFilter[]).map(negate) };
  const flips: Record<string, string> = {
    equals: "does_not_equal",
    does_not_equal: "equals",
    contains: "does_not_contain",
    does_not_contain: "contains",
    is_empty: "is_not_empty",
    is_not_empty: "is_empty",
  };
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "property" || key === "timestamp" || !cond || typeof cond !== "object") continue;
    if (
      key === "date" ||
      key === "created_time" ||
      key === "last_edited_time" ||
      key === "number"
    ) {
      if (!("is_empty" in cond) && !("is_not_empty" in cond)) {
        refuse("날짜 · 숫자 비교의 부정은 옮기지 않습니다 — 반대 비교로 바꿔 쓰세요");
      }
    }
    const [op, value] = Object.entries(cond as Record<string, unknown>)[0] ?? [];
    const flipped = op === undefined ? undefined : flips[op];
    if (!flipped) refuse(`'${String(op)}' 조건의 부정은 옮기지 않습니다`);
    return { ...filter, [key]: { [flipped]: flipped.startsWith("is_") ? true : value } };
  }
  refuse("부정할 조건을 찾지 못했습니다");
}

/** 속성 참조 → Notion 필터의 머리와 타입. */
function targetOf(ref: Ref, schema: Readonly<Record<string, BasePropertySchema>>): Target {
  if (ref.scope === "file") {
    const label = `file.${ref.name}`;
    const timestamp = notionTimestampOf(label);
    if (timestamp) return { head: { timestamp }, type: timestamp, label };
    const title = Object.values(schema).find((p) => p.type === "title");
    if (label === BASES_TITLE && title) {
      return { head: { property: decodePropertyId(title.id) }, type: "title", label };
    }
    refuse(`${label} 은 Notion 속성이 아니라 옮기지 않습니다`);
  }
  const prop = Object.hasOwn(schema, ref.name) ? schema[ref.name] : undefined;
  if (!prop) refuse(`'${ref.name}' 은 이 DB 의 속성이 아닙니다`);
  return {
    head: { property: decodePropertyId(prop.id) },
    type: prop.type,
    label: `속성 '${ref.name}'`,
  };
}

// ─── 상대 기간 ───

interface PendingRange {
  readonly target: Target;
  readonly symbol: string;
  /** 오른쪽 날짜 식(공백 없앤 꼴). */
  readonly text: string;
}

function isPendingRange(filter: NotionFilter): filter is NotionFilter & { pending: PendingRange } {
  return typeof filter["pending"] === "object" && filter["pending"] !== null;
}

/**
 * and 의 항목 가운데 같은 속성의 상대 기간 두 끝을 Notion 의 기간 하나로 모은다. 짝이 없는 끝은 그 값이 상대 날짜
 * 값(`one_week_ago` …)이면 그대로 두고, 아니면(`today() - "1y"`) 남겨 부른 쪽이 거절한다.
 */
function mergeRelativeRanges(items: NotionFilter[]): NotionFilter[] {
  const out = [...items];
  for (const [range, { toward, span }] of Object.entries(RELATIVE_DATE_RANGES)) {
    const [lowText, highText] =
      toward === "past"
        ? [squash(`today() - "${span}"`), "today()"]
        : ["today()", squash(`today() + "${span}"`)];
    for (let i = 0; i < out.length; i++) {
      const low = out[i]!;
      if (!isPendingRange(low) || low.pending.symbol !== ">=" || low.pending.text !== lowText)
        continue;
      const j = out.findIndex(
        (high, k) =>
          k !== i &&
          isPendingRange(high) &&
          high.pending.symbol === "<=" &&
          high.pending.text === highText &&
          JSON.stringify(high.pending.target.head) === JSON.stringify(low.pending.target.head),
      );
      if (j < 0) continue;
      const { target } = low.pending;
      out[i] = { ...target.head, [target.type]: { [range]: {} } };
      out.splice(j, 1);
    }
  }
  return out;
}

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

function depthOf(filter: NotionFilter): number {
  const children = (filter["and"] ?? filter["or"]) as NotionFilter[] | undefined;
  if (!Array.isArray(children)) return 0;
  return 1 + Math.max(0, ...children.map(depthOf));
}
