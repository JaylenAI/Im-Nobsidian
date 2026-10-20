/**
 * 깊이 제한 없는 블록 트리를 append 요청들로 나눈다 — 블록 방식 push 가 NFM 으로 만든 블록을 보낼 때 쓴다
 * (`NotionClient.appendBlockTree`, ADR-035).
 *
 * 블록 API 는 요청 하나에 자식을 두 단계까지만 받고({@link BLOCK_NESTING_MAX}), 배열 하나에 100 개까지,
 * 요청 하나에 블록 1000 개 · 500KB 까지 받는다. 넘는 것은 블록을 만든 뒤 그 블록 아래에 마저 붙인다.
 *
 * 블록마다 놓일 수 있는 깊이가 다르다(SDK 요청 타입): 칼럼 묶음은 요청의 맨 위에만, 표 · 탭은 자식(행 ·
 * 탭)과 함께 만들어야 해서 그 자식이 들어갈 깊이가 남은 곳에만 놓인다. 놓일 수 없는 블록부터는 부모를
 * 만든 뒤 부모 아래에 붙인다 — 순서는 그대로다.
 */
import {
  BLOCK_CHILDREN_MAX,
  BLOCK_NESTING_MAX,
  REQUEST_BLOCKS_MAX,
  REQUEST_BYTES_MAX,
} from "../constants/notion-limits.js";

/** 만들 블록 — 블록 API 요청 모양. 자식은 몸통의 `children` 에 깊이 제한 없이 담는다. */
export interface BlockRequest {
  readonly type: string;
  readonly [body: string]: unknown;
}

/** 만든 블록 아래에 마저 붙일 자식 — `path` 는 요청에 담은 블록에서 자식 순번을 따라간 길. */
export interface PendingChildren {
  readonly path: readonly number[];
  readonly children: readonly BlockRequest[];
}

/** 요청에 담을 블록 하나와, 만든 뒤 마저 붙일 것. */
export interface ShapedBlock {
  readonly body: BlockRequest;
  readonly pending: readonly PendingChildren[];
  /** 요청 안의 블록 수 — 자식 · 표의 행 · 칼럼 포함. */
  readonly count: number;
}

/** 블록 트리를 append 요청들로 — 요청마다 담을 블록들. */
export function shapeAppendRequests(blocks: readonly BlockRequest[]): ShapedBlock[][] {
  const requests: ShapedBlock[][] = [];
  let current: ShapedBlock[] = [];
  let count = 0;
  let bytes = 0;
  for (const block of blocks) {
    const shaped = shapeWithinLimits(block);
    const size = byteLength(shaped.body);
    if (
      current.length > 0 &&
      (current.length >= BLOCK_CHILDREN_MAX ||
        count + shaped.count > REQUEST_BLOCKS_MAX ||
        bytes + size > REQUEST_BYTES_MAX)
    ) {
      requests.push(current);
      current = [];
      count = 0;
      bytes = 0;
    }
    current.push(shaped);
    count += shaped.count;
    bytes += size;
  }
  if (current.length > 0) requests.push(current);
  return requests;
}

/** 한 블록을 요청 한도 안으로 — 너무 크면 담는 깊이를 줄인다(나머지는 만든 뒤 붙인다). */
function shapeWithinLimits(block: BlockRequest): ShapedBlock {
  let shaped = shapeBlock(block, 0, BLOCK_NESTING_MAX);
  for (let depth = BLOCK_NESTING_MAX - 1; depth >= 1; depth -= 1) {
    if (shaped.count <= REQUEST_BLOCKS_MAX && byteLength(shaped.body) <= REQUEST_BYTES_MAX) break;
    shaped = shapeBlock(block, 0, depth);
  }
  return shaped;
}

/**
 * `level` 깊이에 놓을 블록의 요청 모양. 자식은 `maxLevel` 깊이까지 담고, 담지 못한 자식은 `pending` 에 둔다.
 */
export function shapeBlock(block: BlockRequest, level: number, maxLevel: number): ShapedBlock {
  const body = bodyOf(block);
  const children = (body.children as readonly BlockRequest[] | undefined) ?? [];
  if (children.length === 0) return { body: block, pending: [], count: 1 };

  if (block.type === "column_list") {
    // 칼럼은 깊이를 세지 않는다 — 칼럼의 자식이 칼럼 묶음 바로 아래 깊이다.
    const columns = children.map((column, k) => shapeColumn(column, level, maxLevel, k));
    return {
      body: withChildren(
        block,
        columns.map((c) => c.body),
      ),
      pending: columns.flatMap((c) => c.pending),
      count: 1 + columns.reduce((n, c) => n + c.count, 0),
    };
  }

  const { included, rest } = splitChildren(children, level + 1, maxLevel);
  const shapedChildren = included.map((child) => shapeBlock(child, level + 1, maxLevel));
  return {
    body: withChildren(
      block,
      shapedChildren.map((c) => c.body),
    ),
    pending: [
      ...shapedChildren.flatMap((c, k) => c.pending.map((p) => ({ ...p, path: [k, ...p.path] }))),
      ...(rest.length > 0 ? [{ path: [], children: rest }] : []),
    ],
    count: 1 + shapedChildren.reduce((n, c) => n + c.count, 0),
  };
}

/** 칼럼 — 블록 하나는 품어야 만들어진다. 품을 수 있는 첫 자식이 없으면 빈 문단을 둔다. */
function shapeColumn(
  column: BlockRequest,
  level: number,
  maxLevel: number,
  index: number,
): ShapedBlock {
  const children = (bodyOf(column).children as readonly BlockRequest[] | undefined) ?? [];
  const { included, rest } = splitChildren(children, level + 1, maxLevel);
  const head = included.length > 0 ? [] : [EMPTY_PARAGRAPH];
  const shaped = [...head, ...included].map((child) => shapeBlock(child, level + 1, maxLevel));
  return {
    body: withChildren(
      column,
      shaped.map((c) => c.body),
    ),
    pending: [
      ...shaped.flatMap((c, k) => c.pending.map((p) => ({ ...p, path: [index, k, ...p.path] }))),
      ...(rest.length > 0 ? [{ path: [index], children: rest }] : []),
    ],
    count: 1 + shaped.reduce((n, c) => n + c.count, 0),
  };
}

const EMPTY_PARAGRAPH: BlockRequest = { type: "paragraph", paragraph: { rich_text: [] } };

/** 앞에서부터 이 깊이에 놓을 수 있는 자식까지 — 처음 놓을 수 없는 자식부터는 만든 뒤 붙인다. */
function splitChildren(
  children: readonly BlockRequest[],
  level: number,
  maxLevel: number,
): { included: readonly BlockRequest[]; rest: readonly BlockRequest[] } {
  let k = 0;
  while (
    k < children.length &&
    k < BLOCK_CHILDREN_MAX &&
    placeable(children[k]!, level, maxLevel)
  ) {
    k += 1;
  }
  return { included: children.slice(0, k), rest: children.slice(k) };
}

/** 이 깊이에 그 블록을 놓을 수 있는가 — 만들 때 함께 보내야 하는 자식까지 들어갈 깊이가 남았는가. */
function placeable(block: BlockRequest, level: number, maxLevel: number): boolean {
  switch (block.type) {
    case "column_list":
      return level === 0 && maxLevel >= 1;
    case "table":
    case "tab":
      return level + 1 <= maxLevel;
    default:
      return level <= maxLevel;
  }
}

function bodyOf(block: BlockRequest): Record<string, unknown> {
  return (block[block.type] as Record<string, unknown> | undefined) ?? {};
}

/** 자식을 바꾼 사본 — 빈 자식이면 `children` 을 빼고 보낸다. */
function withChildren(block: BlockRequest, children: readonly BlockRequest[]): BlockRequest {
  const rest = { ...bodyOf(block) };
  delete rest.children;
  return {
    ...block,
    [block.type]: children.length > 0 ? { ...rest, children } : rest,
  };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
