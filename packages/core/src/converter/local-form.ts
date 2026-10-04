import { codeLineMask } from "../utils/md-regions.js";
import { alignLines } from "../utils/line-diff.js";
import { alignNoteLines } from "./comments.js";

/**
 * 받은 글에서 Notion 에 같은 모양으로 올라가는 자리를 로컬 노트의 표기로 되돌린다(F-06 · S-30).
 *
 * Notion 에 자리가 없는 표기는 받으면 정준형으로 바뀐다 — 콜아웃 접힘(`+` · `-`)과 종류 별칭(`faq`),
 * `<details>` · `<mark>`, frontmatter 의 목록 모양, 빈 줄 배치, 파일 끝 줄바꿈. 그대로 쓰면 Notion 에서 한
 * 줄만 고쳐도 pull 이 노트 전체를 다시 쓰고, 접어 둔 콜아웃이 모두 펼쳐진다.
 *
 * 되돌린 노트는 push 가 보낼 꼴(`sent`)이 받은 노트와 같아야 한다 — 그래야 Notion 에 있는 것을 잃지
 * 않는다. 노트를 블록(빈 줄로 가른 줄 묶음 — frontmatter · 코드 펜스는 통째로)으로 나눠 로컬 노트와
 * 맞추고, 다른 자리를 로컬 글로 바꿔 본 뒤 보낼 꼴이 그대로일 때만 남긴다. 그래도 안 되는 블록 묶음은
 * 블록 · 줄 단위로 좁혀 본다 — Notion 에서 고친 블록 · 줄만 받은 글이다. 바꿔 보는 횟수는
 * {@link TRIAL_LIMIT} 까지, 긴 노트는 {@link TRIAL_LINE_LIMIT} 이 정한 만큼이다 — 넘으면 남은 자리는 받은
 * 글 그대로다.
 *
 * @param sent 노트를 push 가 보낼 꼴로 — 같은 꼴이면 Notion 에서 같다.
 */
export function restoreLocalForm(
  pulled: string,
  local: string,
  sent: (note: string) => string,
): string {
  // 받은 글은 LF 다 — CRLF 노트도 받으면 LF 로 쓰인다.
  const note = pulled.includes("\r") ? local : local.replace(/\r\n/g, "\n");
  if (note === pulled) return pulled;

  const target = sent(pulled);
  if (sent(note) === target) return note;

  const { slots, spots } = alignBlocks(splitBlocks(note), splitBlocks(pulled));
  const lines = Math.max(note.split("\n").length, pulled.split("\n").length);
  const limit = Math.min(TRIAL_LIMIT, Math.floor(TRIAL_LINE_LIMIT / lines));
  const trial = new Trial(sent, target, slots, limit - 2);
  // 모두 로컬 글로 바꾼 노트는 위에서 봤다.
  const failed = trial.bisect(spots, (group, local) => {
    for (const spot of group) trial.slots[spot.slot] = [...(local ? spot.local : spot.pulled)];
  });
  // 혼자서도 안 되는 블록 묶음에는 Notion 에서 고친 블록이 있다 — 그 블록 · 줄만 받은 글로 남긴다.
  for (const { slot, run } of failed) {
    if (run) trial.refine(run.local, run.pulled, (lines) => trial.put(slot, lines));
  }
  return render(trial.slots);
}

/** 노트 하나에서 보낼 꼴을 만들어 보는 횟수 상한 — 한 번마다 노트 전체를 push 의 눈으로 본다. */
const TRIAL_LIMIT = 64;
/**
 * 보낼 꼴을 만들어 보는 노트 줄 수의 합 상한 — 긴 노트는 그만큼 덜 바꿔 본다. 한 번에 줄마다 약 4µs 라
 * (2026-10-04 실볼트 실측: 10,459줄 노트 한 번 42ms) 노트 하나가 pull 을 0.5초 넘게 붙잡지 않는다.
 */
const TRIAL_LINE_LIMIT = 100_000;

/** 블록 — 빈 줄로 가른 줄 묶음과 그 앞의 빈 줄. */
interface Block {
  readonly gap: readonly string[];
  readonly lines: readonly string[];
  /** 맞출 때 견주는 글 — 앞의 빈 줄은 빼고. */
  readonly text: string;
}

interface Blocks {
  readonly blocks: readonly Block[];
  /** 마지막 블록 뒤의 줄 — 빈 줄과 끝 줄바꿈. */
  readonly tail: readonly string[];
}

/** 공백뿐인 줄 — 블록을 가른다. 인용 안의 빈 줄(`>`)은 콜아웃의 일부다. */
const BLANK_LINE_RE = /^[ \t]*$/;
/** frontmatter 를 여닫는 줄 — `splitFrontmatter` 와 같다. */
const DELIMITER_LINE = "---";

/** 노트를 블록으로 — frontmatter 와 코드 펜스는 안의 빈 줄에서 가르지 않는다. */
function splitBlocks(text: string): Blocks {
  const lines = text.split("\n");
  const inCode = codeLineMask(text);
  const frontmatterEnd =
    lines[0] === DELIMITER_LINE ? lines.findIndex((l, i) => i > 0 && l === DELIMITER_LINE) : -1;
  const blocks: Block[] = [];
  let gap: string[] = [];
  let current: string[] | null = null;
  const flush = () => {
    if (current === null) return;
    blocks.push({ gap, lines: current, text: current.join("\n") });
    gap = [];
    current = null;
  };
  lines.forEach((line, i) => {
    if (i > frontmatterEnd && !inCode[i] && BLANK_LINE_RE.test(line)) {
      flush();
      gap.push(line);
      return;
    }
    (current ??= []).push(line);
    if (i === frontmatterEnd) flush();
  });
  flush();
  return { blocks, tail: gap };
}

function linesOf(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block) => [...block.gap, ...block.lines]);
}

function render(slots: readonly (readonly string[])[]): string {
  return slots.flat().join("\n");
}

/** 받은 글 대신 로컬 글을 넣어 볼 자리. */
interface Spot {
  readonly slot: number;
  readonly local: readonly string[];
  readonly pulled: readonly string[];
  /** 블록 묶음이 다른 자리 — 통째로 안 되면 좁혀 본다. 블록 앞 빈 줄 · 끝 자리는 없다. */
  readonly run?: { readonly local: readonly Block[]; readonly pulled: readonly Block[] };
}

/**
 * 받은 노트를 자리(slot)로 — 같은 블록, 그 앞의 빈 줄, 다른 블록 묶음, 끝. 자리는 처음에 받은 글이고,
 * 로컬 글과 다른 자리마다 넣어 볼 로컬 글(spot)을 단다.
 */
function alignBlocks(local: Blocks, pulled: Blocks): { slots: string[][]; spots: Spot[] } {
  const slots: string[][] = [];
  const spots: Spot[] = [];
  const offer = (
    pulledLines: readonly string[],
    localLines: readonly string[],
    run?: Spot["run"],
  ) => {
    slots.push([...pulledLines]);
    if (sameLines(pulledLines, localLines)) return;
    const slot = slots.length - 1;
    spots.push({ slot, local: localLines, pulled: pulledLines, ...(run ? { run } : {}) });
  };

  const l = local.blocks;
  const p = pulled.blocks;
  forEachRun(
    l.map((b) => b.text),
    p.map((b) => b.text),
    (i, j) => {
      offer(p[j]!.gap, l[i]!.gap);
      slots.push([...p[j]!.lines]);
    },
    (i, nextI, j, nextJ) => {
      const run = { local: l.slice(i, nextI), pulled: p.slice(j, nextJ) };
      offer(linesOf(run.pulled), linesOf(run.local), run);
    },
  );
  offer(pulled.tail, local.tail);
  return { slots, spots };
}

/**
 * 두 목록을 맞춰 차례대로 — 같은 짝은 `same(i, j)`, 그 사이의 다른 묶음은 `changed(i, nextI, j, nextJ)`
 * (`[i, nextI)` 와 `[j, nextJ)`, 한쪽은 비어 있을 수 있다).
 */
function forEachRun(
  local: readonly string[],
  pulled: readonly string[],
  same: (i: number, j: number) => void,
  changed: (i: number, nextI: number, j: number, nextJ: number) => void,
): void {
  const match = alignLines(local, pulled);
  let i = 0;
  let j = 0;
  while (i < local.length || j < pulled.length) {
    if (i < local.length && match[i] === j) {
      same(i++, j++);
      continue;
    }
    let nextI = i;
    while (nextI < local.length && match[nextI] === -1) nextI++;
    const nextJ = nextI < local.length ? match[nextI]! : pulled.length;
    changed(i, nextI, j, nextJ);
    i = nextI;
    j = nextJ;
  }
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, k) => line === b[k]);
}

/**
 * 다른 줄 묶음을 조각으로 — 고친 줄로 볼 만큼 비슷한 줄끼리 짝짓고({@link alignNoteLines}), 그 사이는 앞에서부터
 * 한 줄씩 짝짓는다. 남는 줄은 한쪽만의 조각이다 — 콜아웃 속 문단 경계(`>`)처럼 로컬에만 있는 줄도 Notion 에서
 * 고친 이웃 줄과 따로 넣어 본다.
 */
function pieces(
  local: readonly string[],
  pulled: readonly string[],
): Array<readonly [own: readonly string[], theirs: readonly string[]]> {
  const { match } = alignNoteLines(local, pulled);
  const out: Array<readonly [readonly string[], readonly string[]]> = [];
  let pending: string[] = [];
  let j = 0;
  const zip = (to: number) => {
    const theirs = pulled.slice(j, to);
    for (let k = 0; k < Math.max(pending.length, theirs.length); k++) {
      out.push([pending.slice(k, k + 1), theirs.slice(k, k + 1)]);
    }
    pending = [];
    j = to;
  };
  local.forEach((line, i) => {
    const at = match[i]!;
    if (at < 0) {
      pending.push(line);
      return;
    }
    zip(at);
    out.push([[line], [pulled[at]!]]);
    j = at + 1;
  });
  zip(pulled.length);
  return out;
}

/** 넣어 볼 줄 — 맞으면 남기고 true, 아니면 되돌리고 false. */
type Put = (lines: readonly string[]) => boolean;

/** 자리를 바꿔 보고 보낼 꼴이 그대로인지 보는 일 — 횟수를 센다. */
class Trial {
  constructor(
    private readonly sent: (note: string) => string,
    private readonly target: string,
    readonly slots: string[][],
    private budget: number,
  ) {}

  /** 지금 자리들로 쓴 노트가 받은 노트와 같은 꼴인가. 횟수를 다 썼으면 아니다. */
  private fits(): boolean {
    if (this.budget <= 0) return false;
    this.budget--;
    return this.sent(render(this.slots)) === this.target;
  }

  /** 자리 하나를 `lines` 로 바꿔 본다 — 맞으면 남기고, 아니면 되돌린다. */
  put(slot: number, lines: readonly string[]): boolean {
    const saved = this.slots[slot]!;
    this.slots[slot] = [...lines];
    if (this.fits()) return true;
    this.slots[slot] = saved;
    return false;
  }

  /**
   * 여러 자리를 한 번에 로컬 글로 바꿔 보고, 안 되면 반씩 나눠 다시 본다 — Notion 에서 고친 자리는 보통
   * 한두 곳이라, 자리가 많아도 몇 번 만에 가려진다. 혼자서도 안 되는 자리를 돌려준다.
   *
   * @param swap 자리들을 로컬 글(true) · 받은 글(false)로.
   * @param check 지금 모양이 맞는가 — 기본은 노트 전체를 본다.
   * @param tried 모두 바꾼 모양은 이미 봤다.
   */
  bisect<T>(
    items: readonly T[],
    swap: (group: readonly T[], local: boolean) => void,
    check: () => boolean = () => this.fits(),
    tried = true,
  ): T[] {
    const failed: T[] = [];
    const visit = (group: readonly T[], seen: boolean) => {
      if (group.length === 0) return;
      if (!seen) {
        swap(group, true);
        if (check()) return;
        swap(group, false);
      }
      if (group.length === 1 || this.budget <= 0) {
        failed.push(...group);
        return;
      }
      const half = group.length >> 1;
      visit(group.slice(0, half), false);
      visit(group.slice(half), false);
    };
    visit(items, tried);
    return failed;
  }

  /**
   * 통째로는 안 되는 블록 묶음을 좁혀 본다 — Notion 에서 고친 블록 · 줄만 받은 글로 남긴다. 블록 수가 같으면
   * 블록끼리 짝지어 보고, 다르면 앞에서부터 · 뒤에서부터 맞는 블록 묶음을 떼어 본다. 그래도 안 되는 자리는
   * 줄 단위로. 남긴 줄을 돌려준다.
   *
   * @param put 이 묶음 자리에 넣어 볼 줄 — 바깥에서 뗀 앞뒤 블록은 put 이 붙인다.
   * @param whole 묶음을 통째로 넣어 볼까 — 처음 부를 때는 이미 해 봤다.
   */
  refine(local: readonly Block[], pulled: readonly Block[], put: Put, whole = false): string[] {
    if (whole && put(linesOf(local))) return linesOf(local);
    const n = local.length;
    const m = pulled.length;
    if (n === 0 || m === 0 || this.budget <= 0) return linesOf(pulled);
    if (n === m) return this.refinePairs(local, pulled, put);
    return this.refineEnds(local, pulled, put);
  }

  /**
   * 블록 수가 같은 묶음 — 블록끼리 짝지어, 블록 앞 빈 줄과 블록 줄을 따로 한꺼번에 · 반씩 넣어 본다. 빈 줄
   * 배치는 그 블록을 Notion 에서 고쳤어도 되살린다. 안 되는 블록 줄은 줄 단위로.
   */
  private refinePairs(local: readonly Block[], pulled: readonly Block[], put: Put): string[] {
    // 블록 k 의 앞 빈 줄은 2k, 줄은 2k+1 번째 조각이다.
    const parts = (blocks: readonly Block[]) => blocks.flatMap((b) => [b.gap, b.lines]);
    const own = parts(local);
    const theirs = parts(pulled);
    const chosen = theirs.map((lines) => [...lines]);
    const putPart = (k: number, lines: readonly string[]): boolean => {
      const saved = chosen[k]!;
      chosen[k] = [...lines];
      if (put(chosen.flat())) return true;
      chosen[k] = saved;
      return false;
    };
    const differs = own.flatMap((lines, k) => (sameLines(lines, theirs[k]!) ? [] : [k]));
    const failed = this.bisect(
      differs,
      (group, useLocal) => {
        for (const k of group) chosen[k] = [...(useLocal ? own : theirs)[k]!];
      },
      () => put(chosen.flat()),
    );
    for (const k of failed) {
      if (k % 2 === 0 || this.budget <= 0) continue;
      this.refineLines(own[k]!, theirs[k]!, (lines) => putPart(k, lines));
    }
    return chosen.flat();
  }

  /**
   * 블록 수가 다른 묶음 — 앞에서부터 · 뒤에서부터 맞는 블록 묶음을 찾아 떼고 남은 묶음을 다시 좁힌다.
   * `<details>` 는 빈 줄로 블록이 갈려 받은 토글 콜아웃 하나와 블록 수가 다르다.
   */
  private refineEnds(local: readonly Block[], pulled: readonly Block[], put: Put): string[] {
    const n = local.length;
    const m = pulled.length;
    for (let i = 1; i <= n && this.budget > 0; i++) {
      for (let j = 1; j <= m && this.budget > 0; j++) {
        if (i === n && j === m) continue;
        const head = linesOf(local.slice(0, i));
        if (!put([...head, ...linesOf(pulled.slice(j))])) continue;
        const rest = this.refine(
          local.slice(i),
          pulled.slice(j),
          (lines) => put([...head, ...lines]),
          true,
        );
        return [...head, ...rest];
      }
    }
    for (let i = 1; i <= n && this.budget > 0; i++) {
      for (let j = 1; j <= m && this.budget > 0; j++) {
        if (i === n && j === m) continue;
        const tail = linesOf(local.slice(n - i));
        if (!put([...linesOf(pulled.slice(0, m - j)), ...tail])) continue;
        const rest = this.refine(
          local.slice(0, n - i),
          pulled.slice(0, m - j),
          (lines) => put([...lines, ...tail]),
          true,
        );
        return [...rest, ...tail];
      }
    }
    return this.refineLines(linesOf(local), linesOf(pulled), put);
  }

  /**
   * 줄 단위로 — 다른 줄 묶음을 조각({@link pieces})으로 갈라 로컬 줄을 넣어 본다. 콜아웃 머리줄의 접힘과
   * Notion 에서 고친 본문 줄이 이어져 있어도 머리줄은 되살린다. 묶음 전체는 부르는 쪽이 봤다.
   */
  private refineLines(local: readonly string[], pulled: readonly string[], put: Put): string[] {
    const chosen: string[][] = [];
    const spots: Array<{
      readonly index: number;
      readonly local: readonly string[];
      readonly pulled: readonly string[];
    }> = [];
    forEachRun(
      local,
      pulled,
      (_i, j) => chosen.push([pulled[j]!]),
      (i, nextI, j, nextJ) => {
        for (const [own, theirs] of pieces(local.slice(i, nextI), pulled.slice(j, nextJ))) {
          chosen.push([...theirs]);
          if (!sameLines(own, theirs)) {
            spots.push({ index: chosen.length - 1, local: own, pulled: theirs });
          }
        }
      },
    );
    this.bisect(
      spots,
      (group, useLocal) => {
        for (const spot of group) {
          chosen[spot.index] = [...(useLocal ? spot.local : spot.pulled)];
        }
      },
      () => put(chosen.flat()),
    );
    return chosen.flat();
  }
}
