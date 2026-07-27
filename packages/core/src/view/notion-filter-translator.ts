import type { BasePropertySchema, BaseStatusGroup } from "../types/view.js";

/**
 * Notion 뷰 필터식 → Obsidian Bases 필터식 번역기.
 *
 * ## 왜 필요한가
 *
 * Notion 뷰의 절반 가까이는 필터가 걸려 있다. 그런데 `.base` 는 폴더 필터만 내보냈고,
 * 사이드카는 "Notion 필터식은 .base 로 표현되지 않음"이라 적어 두고 끝냈다. 그래서
 * '시작전, 진행중' 이라는 이름의 뷰가 Obsidian 에서는 **완료된 행까지 전부** 보여 줬다 —
 * 이름과 내용이 어긋나는, 사용자가 오해하기 딱 좋은 상태였다. Bases 는 뷰마다 `filters:`
 * 를 지원하므로(공식 문서 `views[].filters`) 표현 가능한 조건은 실제로 옮길 수 있다.
 *
 * ## 부분 번역의 안전 규칙 — 이 파일의 핵심
 *
 * Notion 필터 문법은 Bases 보다 넓다(rollup any/every/none, 상대 날짜, formula 등).
 * 못 옮기는 리프를 만났을 때 **어느 방향으로 틀릴지**는 논리 위치에 따라 다르다:
 *
 *   - `and` 안에서 리프 하나를 버리면 조건이 느슨해진다 → 결과는 **상위집합**.
 *     Notion 보다 행이 더 보인다. 눈에 보이는 과다 표시이고, 데이터는 잃지 않는다.
 *   - `or` 안에서 가지 하나를 버리면 조건이 조여진다 → 결과는 **부분집합**.
 *     Notion 에 있던 행이 Obsidian 에서 **조용히 사라진다**. 이건 유실이다.
 *   - `not` 은 안쪽을 버리면 부정의 의미 자체가 뒤집힌다.
 *
 * 그래서 `and` 는 번역 가능한 리프만 남기고, `or`/`not` 은 하나라도 못 옮기면 그룹
 * 전체를 포기한다. 포기한 것은 전부 {@link TranslationResult.untranslated} 로 보고돼
 * 사이드카 degrade 리포트에 실린다 — 조용히 넘어가는 경로는 없다.
 */

/** Bases 필터 노드 — 문자열 표현식이거나 and/or/not 그룹. */
export type BasesFilterNode =
  | string
  | { readonly and: BasesFilterNode[] }
  | { readonly or: BasesFilterNode[] }
  | { readonly not: BasesFilterNode[] };

export interface TranslationResult {
  /** 번역된 필터. 옮길 수 있는 조건이 하나도 없으면 null. */
  readonly node: BasesFilterNode | null;
  /** 옮기지 못한 조건의 사람용 설명(중복 제거·정렬됨). */
  readonly untranslated: string[];
}

/** 속성 id/이름 → 프론트매터 키. 스키마에서 못 찾으면 undefined. */
export type PropertyNameResolver = (idOrName: string) => string | undefined;

interface Ctx {
  readonly resolveName: PropertyNameResolver;
  readonly schema: Record<string, BasePropertySchema>;
  readonly untranslated: Set<string>;
}

/**
 * Notion 필터 객체를 Bases 필터 노드로 옮긴다.
 *
 * @param filter Notion `views.retrieve` 가 준 필터 객체(`unknown` — 문법이 계속 늘어난다).
 * @param schema DB 속성 스키마. 속성 id 해소와 status 그룹 전개에 쓴다.
 * @param resolveName 속성 id(또는 이름) → 프론트매터 키 해소기.
 */
export function translateNotionFilter(
  filter: unknown,
  schema: Record<string, BasePropertySchema>,
  resolveName: PropertyNameResolver,
): TranslationResult {
  const ctx: Ctx = { resolveName, schema, untranslated: new Set() };
  const node = translateNode(filter, ctx);
  return {
    node,
    untranslated: [...ctx.untranslated].sort((a, b) => a.localeCompare(b)),
  };
}

function translateNode(node: unknown, ctx: Ctx): BasesFilterNode | null {
  if (!isRecord(node)) return null;

  if (Array.isArray(node["and"])) {
    // and: 옮길 수 있는 것만 남긴다(결과는 상위집합 — 과다 표시이지 유실이 아니다).
    const parts = node["and"].map((c) => translateNode(c, ctx)).filter(isNode);
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0]! : { and: parts };
  }

  if (Array.isArray(node["or"])) {
    // or: 가지 하나라도 못 옮기면 전체 포기. 남기면 결과가 부분집합이 돼 행이 사라진다.
    const children = node["or"];
    const parts: BasesFilterNode[] = [];
    for (const child of children) {
      const part = translateNode(child, ctx);
      if (part === null) {
        ctx.untranslated.add("or 그룹 안에 옮길 수 없는 조건이 있어 그룹 전체를 생략함");
        return null;
      }
      parts.push(part);
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0]! : { or: parts };
  }

  // Notion 의 부정은 does_not_* 연산자로 오지만, 문법이 넓어질 때를 대비해 받아 둔다.
  if (Array.isArray(node["not"])) {
    const parts: BasesFilterNode[] = [];
    for (const child of node["not"]) {
      const part = translateNode(child, ctx);
      if (part === null) {
        ctx.untranslated.add("not 그룹 안에 옮길 수 없는 조건이 있어 그룹 전체를 생략함");
        return null;
      }
      parts.push(part);
    }
    return parts.length === 0 ? null : { not: parts };
  }

  return translateLeaf(node, ctx);
}

/** 리프 = `{ property, <typeKey>: { <op>: value } }` 또는 `{ timestamp, created_time: {...} }`. */
function translateLeaf(leaf: Record<string, unknown>, ctx: Ctx): BasesFilterNode | null {
  const timestamp = leaf["timestamp"];
  if (typeof timestamp === "string") {
    const ref = timestamp === "created_time" ? "file.ctime" : "file.mtime";
    const cond = leaf[timestamp];
    if (!isRecord(cond)) return unsupported(ctx, `timestamp '${timestamp}' 필터`);
    return translateDate(ref, cond, ctx, `timestamp '${timestamp}'`);
  }

  const propRaw = leaf["property"];
  if (typeof propRaw !== "string") return null;

  const propName = ctx.resolveName(propRaw);
  if (!propName) {
    return unsupported(ctx, `속성 '${propRaw}' 을 스키마에서 찾지 못해 조건을 생략함`);
  }
  const ref = noteRef(propName);
  const label = `속성 '${propName}'`;

  for (const [typeKey, condRaw] of Object.entries(leaf)) {
    if (typeKey === "property") continue;
    if (!isRecord(condRaw)) continue;

    switch (typeKey) {
      case "title":
      case "rich_text":
      case "url":
      case "email":
      case "phone_number":
        return translateText(ref, condRaw, ctx, label);
      case "number":
        return translateNumber(ref, condRaw, ctx, label);
      case "checkbox":
        return translateCheckbox(ref, condRaw, ctx, label);
      case "select":
        return translateSelect(ref, condRaw, ctx, label);
      case "status":
        return translateStatus(ref, condRaw, ctx, label, propName);
      case "multi_select":
      case "relation":
      case "people":
        return translateList(ref, condRaw, ctx, label);
      case "files":
        return translateEmptiness(ref, condRaw, ctx, label);
      case "date":
      case "created_time":
      case "last_edited_time":
        return translateDate(ref, condRaw, ctx, label);
      case "formula":
      case "rollup":
        // formula/rollup 은 Notion 이 계산한 값이라 프론트매터에 그대로 있지 않다.
        // 억지로 옮기면 조용히 틀린 뷰가 되므로 옮기지 않는다.
        return unsupported(ctx, `${label}: ${typeKey} 필터는 Bases 로 옮길 수 없음`);
      default:
        return unsupported(ctx, `${label}: '${typeKey}' 필터 유형 미지원`);
    }
  }

  return null;
}

function translateText(
  ref: string,
  cond: Record<string, unknown>,
  ctx: Ctx,
  label: string,
): BasesFilterNode | null {
  const empt = translateEmptinessOnly(ref, cond);
  if (empt) return empt;

  const [op, value] = firstEntry(cond);
  if (typeof value !== "string") return unsupported(ctx, `${label}: '${op}' 값이 문자열이 아님`);
  const lit = str(value);

  switch (op) {
    case "equals":
      return `${ref} == ${lit}`;
    case "does_not_equal":
      return `${ref} != ${lit}`;
    case "contains":
      return `${ref}.contains(${lit})`;
    case "does_not_contain":
      return `!${ref}.contains(${lit})`;
    case "starts_with":
      return `${ref}.startsWith(${lit})`;
    case "ends_with":
      return `${ref}.endsWith(${lit})`;
    default:
      return unsupported(ctx, `${label}: 텍스트 연산자 '${op}' 미지원`);
  }
}

function translateNumber(
  ref: string,
  cond: Record<string, unknown>,
  ctx: Ctx,
  label: string,
): BasesFilterNode | null {
  const empt = translateEmptinessOnly(ref, cond);
  if (empt) return empt;

  const [op, value] = firstEntry(cond);
  if (typeof value !== "number") return unsupported(ctx, `${label}: '${op}' 값이 숫자가 아님`);

  switch (op) {
    case "equals":
      return `${ref} == ${value}`;
    case "does_not_equal":
      return `${ref} != ${value}`;
    case "greater_than":
      return `${ref} > ${value}`;
    case "less_than":
      return `${ref} < ${value}`;
    case "greater_than_or_equal_to":
      return `${ref} >= ${value}`;
    case "less_than_or_equal_to":
      return `${ref} <= ${value}`;
    default:
      return unsupported(ctx, `${label}: 숫자 연산자 '${op}' 미지원`);
  }
}

function translateCheckbox(
  ref: string,
  cond: Record<string, unknown>,
  ctx: Ctx,
  label: string,
): BasesFilterNode | null {
  const [op, value] = firstEntry(cond);
  if (typeof value !== "boolean") return unsupported(ctx, `${label}: '${op}' 값이 불리언이 아님`);
  if (op === "equals") return `${ref} == ${value}`;
  if (op === "does_not_equal") return `${ref} != ${value}`;
  return unsupported(ctx, `${label}: 체크박스 연산자 '${op}' 미지원`);
}

function translateSelect(
  ref: string,
  cond: Record<string, unknown>,
  ctx: Ctx,
  label: string,
): BasesFilterNode | null {
  const empt = translateEmptinessOnly(ref, cond);
  if (empt) return empt;

  const [op, value] = firstEntry(cond);
  const names = toStringList(value);
  if (names === null) return unsupported(ctx, `${label}: '${op}' 값 형태를 해석하지 못함`);
  return equalityOverNames(ref, op, names, ctx, label);
}

/**
 * status 필터는 옵션명이 아니라 **그룹명**(To-do/In progress/Complete)으로 올 수 있다.
 * 실제 데이터가 그랬다 — 옵션은 '시작 전/진행 중/보류' 인데 필터는 `["To-do","In progress"]`.
 * 그룹명을 그대로 비교식에 넣으면 **아무 행도 안 걸리는** 조용히 빈 뷰가 된다.
 * 그래서 그룹명이면 소속 옵션명으로 전개한 뒤 비교한다.
 */
function translateStatus(
  ref: string,
  cond: Record<string, unknown>,
  ctx: Ctx,
  label: string,
  propName: string,
): BasesFilterNode | null {
  const empt = translateEmptinessOnly(ref, cond);
  if (empt) return empt;

  const [op, value] = firstEntry(cond);
  const raw = toStringList(value);
  if (raw === null) return unsupported(ctx, `${label}: '${op}' 값 형태를 해석하지 못함`);

  const prop = ctx.schema[propName];
  const optionNames = new Set((prop?.options ?? []).map((o) => o.name));
  const expanded: string[] = [];
  for (const name of raw) {
    if (optionNames.has(name)) {
      expanded.push(name);
      continue;
    }
    const group = prop?.groups?.find((g) => g.name === name);
    const members = group && prop ? expandGroup(group, prop) : null;
    if (members === null) {
      return unsupported(ctx, `${label}: 상태 '${name}' 을 옵션으로 전개하지 못함`);
    }
    expanded.push(...members);
  }

  // 그룹이 비어 있으면(옵션 0개) 어떤 행도 만족할 수 없다 — 억지로 참이 되는 식을
  // 만들지 않고 생략해 상위집합 쪽으로 틀린다.
  if (expanded.length === 0) {
    return unsupported(ctx, `${label}: 상태 그룹에 속한 옵션이 없어 조건을 생략함`);
  }

  return equalityOverNames(ref, op, dedupe(expanded), ctx, label);
}

/** status 그룹 → 소속 옵션명. option id 를 스키마에서 못 찾으면 null(전개 실패). */
function expandGroup(group: BaseStatusGroup, prop: BasePropertySchema): string[] | null {
  const ids = group.optionIds;
  if (!ids || ids.length === 0) return [];
  const byId = new Map((prop.options ?? []).map((o) => [o.id, o.name] as const));
  const names: string[] = [];
  for (const id of ids) {
    const name = id === undefined ? undefined : byId.get(id);
    // 옵션 id 를 못 찾으면 그룹을 부분 전개하게 된다 — 조용한 부분집합이므로 실패로 본다.
    if (name === undefined) return null;
    names.push(name);
  }
  return names;
}

/** 단일값 속성(select/status)에 대한 equals/does_not_equal 을 이름 목록으로 전개한다. */
function equalityOverNames(
  ref: string,
  op: string,
  names: string[],
  ctx: Ctx,
  label: string,
): BasesFilterNode | null {
  if (names.length === 0) return unsupported(ctx, `${label}: '${op}' 비교 대상이 비어 있음`);

  if (op === "equals") {
    const parts = names.map((n) => `${ref} == ${str(n)}`);
    return parts.length === 1 ? parts[0]! : { or: parts };
  }
  if (op === "does_not_equal") {
    // "이 중 어느 것도 아님" — or 의 부정이 아니라 and 의 연쇄여야 한다.
    const parts = names.map((n) => `${ref} != ${str(n)}`);
    return parts.length === 1 ? parts[0]! : { and: parts };
  }
  return unsupported(ctx, `${label}: 선택 연산자 '${op}' 미지원`);
}

function translateList(
  ref: string,
  cond: Record<string, unknown>,
  ctx: Ctx,
  label: string,
): BasesFilterNode | null {
  const empt = translateEmptinessOnly(ref, cond);
  if (empt) return empt;

  const [op, value] = firstEntry(cond);
  const names = toStringList(value);
  if (names === null) return unsupported(ctx, `${label}: '${op}' 값 형태를 해석하지 못함`);
  const args = names.map(str).join(", ");

  if (op === "contains") return `${ref}.containsAny(${args})`;
  if (op === "does_not_contain") return `!${ref}.containsAny(${args})`;
  return unsupported(ctx, `${label}: 목록 연산자 '${op}' 미지원`);
}

function translateEmptiness(
  ref: string,
  cond: Record<string, unknown>,
  ctx: Ctx,
  label: string,
): BasesFilterNode | null {
  const empt = translateEmptinessOnly(ref, cond);
  if (empt) return empt;
  const [op] = firstEntry(cond);
  return unsupported(ctx, `${label}: 연산자 '${op}' 미지원`);
}

/**
 * 날짜 필터. 절대 시각(equals/before/after/on_or_*)만 옮긴다.
 *
 * `past_week`·`this_month` 같은 상대 조건은 Bases 에도 대응 표현이 있지만, Notion 의
 * 기준 시각·주 시작 요일 정의와 어긋나면 경계 근처 행이 조용히 어긋난다. 잘못 옮기느니
 * 생략하고 사이드카에 남기는 쪽을 택한다(상위집합).
 */
function translateDate(
  ref: string,
  cond: Record<string, unknown>,
  ctx: Ctx,
  label: string,
): BasesFilterNode | null {
  const empt = translateEmptinessOnly(ref, cond);
  if (empt) return empt;

  const [op, value] = firstEntry(cond);
  if (typeof value !== "string") {
    return unsupported(ctx, `${label}: 상대 날짜 조건 '${op}' 은 옮기지 않음`);
  }
  const lit = str(value);

  switch (op) {
    case "equals":
      return `${ref} == ${lit}`;
    case "before":
      return `${ref} < ${lit}`;
    case "after":
      return `${ref} > ${lit}`;
    case "on_or_before":
      return `${ref} <= ${lit}`;
    case "on_or_after":
      return `${ref} >= ${lit}`;
    default:
      return unsupported(ctx, `${label}: 날짜 연산자 '${op}' 미지원`);
  }
}

/** is_empty/is_not_empty 는 모든 타입에 공통이라 한 곳에서 처리한다. */
function translateEmptinessOnly(ref: string, cond: Record<string, unknown>): string | null {
  if (cond["is_empty"] === true) return `${ref}.isEmpty()`;
  if (cond["is_not_empty"] === true) return `!${ref}.isEmpty()`;
  return null;
}

function unsupported(ctx: Ctx, reason: string): null {
  ctx.untranslated.add(reason);
  return null;
}

/** 프론트매터 키 참조 — 공백·한글·기호를 포함한 Notion 속성명을 안전하게 감싼다. */
function noteRef(propertyName: string): string {
  return `note[${str(propertyName)}]`;
}

/** Bases 식 안의 문자열 리터럴(큰따옴표, 역슬래시·따옴표 이스케이프). */
function str(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 값이 문자열이거나 문자열 배열이면 배열로 정규화. 그 외에는 null. */
function toStringList(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  return null;
}

function firstEntry(cond: Record<string, unknown>): [string, unknown] {
  const entries = Object.entries(cond);
  return entries[0] ?? ["", undefined];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNode(value: BasesFilterNode | null): value is BasesFilterNode {
  return value !== null;
}
