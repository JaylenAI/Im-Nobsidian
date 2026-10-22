import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { codeFingerprint, fenceCodeText } from "../code-fence.js";
import { scanCodeFences, type CodeFence } from "../../utils/md-regions.js";
import { isNotionLanguageInfo, notionCodeLanguage } from "../code-language.js";

/**
 * 받은 코드 펜스를 로컬 노트의 원래 표기로 되돌린다(S-20) — `CodeLanguageGuard` 의 pull 쪽 절반.
 *
 * Notion 은 펜스 언어를 제 이름으로 저장한다(`ts` → typescript, `dataview` → push 가 보낸 plain text).
 * 받은 그대로 쓰면 노트의 펜스가 바뀌고 Dataview 쿼리가 죽는다. 원래 표기는 Notion 에 남길 자리가
 * 없어(코드 캡션은 markdown 으로 오가지 않는다 — 실측) **받기 직전의 로컬 노트**(`localContent`)에서 찾는다.
 * 그래서 이 버전 전에 올린 노트도 되살아난다 — 그때 Notion 이 javascript 로 저장한 펜스까지.
 *
 * 짝짓기는 두 번 한다.
 *  1) 코드가 같은(공백 무시) 로컬 펜스 — 펜스 기호 · 정보 문자열을 그대로 되돌린다.
 *  2) 남은 것 중 언어가 맞는 로컬 펜스 — Notion 에서 코드를 고친 블록이다. 정보 문자열만 되돌린다.
 *     남은 수가 같으면 순서대로, 다르면(Notion 에서 블록을 더하거나 뺐다) 같은 줄이 있는 것끼리만 —
 *     같은 줄이 많은 짝부터 정한다.
 * 언어가 맞지 않으면 짝짓지 않는다 — Notion 에서 언어를 바꾼 것이니 그쪽을 따른다.
 *
 * 코드가 같은 짝은 옛 push 가 줄인 코드 속 빈 줄도 되살린다(S-27, {@link restoredBlankLines}).
 */
export class CodeLanguageRestorer implements Processor {
  readonly name = "CodeLanguageRestorer";
  readonly order = 36;

  process(input: ProcessorInput): ProcessorOutput {
    const local = input.metadata.localContent;
    if (input.context.direction !== "pull" || typeof local !== "string") {
      return { content: input.content, metadata: input.metadata };
    }

    const originals = scanCodeFences(local).filter((fence) => fence.close !== null);
    const pulled = scanCodeFences(input.content).filter((fence) => fence.close !== null);
    if (originals.length === 0 || pulled.length === 0) {
      return { content: input.content, metadata: input.metadata };
    }

    const lines = input.content.split("\n");
    const localLines = local.split("\n");
    // 아래 펜스부터 — 빈 줄을 되살리면 그 뒤 줄 번호가 밀린다.
    const pairs = pairFences(pulled, originals).sort((a, b) => b.fence.open - a.fence.open);
    for (const { fence, original, exact } of pairs) {
      const bar = exact ? original.bar : fence.bar;
      lines[fence.open] = fence.lead + bar + original.info;
      if (!exact) continue;
      const close = fence.close!;
      lines[close] = fence.closeLead! + original.closeBar!;
      const body = restoredBlankLines(
        fence,
        lines.slice(fence.open + 1, close),
        original,
        localLines.slice(original.open + 1, original.close!),
      );
      if (body) lines.splice(fence.open + 1, close - fence.open - 1, ...body);
    }

    return { content: lines.join("\n"), metadata: input.metadata };
  }
}

interface FencePair {
  readonly fence: CodeFence;
  readonly original: CodeFence;
  /** 코드까지 같은 짝인가 — 펜스 기호까지 되돌려도 안전하다. */
  readonly exact: boolean;
}

/**
 * 옛 push 가 줄인 코드 속 빈 줄을 되살린 코드 줄 — 되살릴 것이 없으면 null.
 *
 * v0.4.0 전의 push 는 노트 전체에서 이어진 빈 줄(`\n{3,}`)을 한 줄로 줄여 코드 속 빈 줄까지 줄였다
 * (S-27). 그때 올린 코드는 Notion 에 그렇게 남아, 원격의 다른 곳이 바뀌어 받으면 로컬 코드의 빈 줄을
 * 지웠다(실측). 받은 코드가 로컬 코드를 그렇게 줄인 것과 같을 때만, 그리고 옛 push 가 줄일 수 있던
 * 자리 — 원문이 아무것도 없는 줄인 곳(인용의 `>` 줄 · CRLF 노트의 줄은 줄지 않았다)만 되살린다.
 * Notion 에서 그 빈 줄만 줄인 편집도 같아 보여 되살아난다 — 둘은 가를 수 없다.
 *
 * @param pulledRaw 받은 코드 줄 원문 — 되살리는 빈 줄은 이 모양(인용 표시 · 들여쓰기)을 따른다.
 * @param localRaw 로컬 코드 줄 원문.
 */
function restoredBlankLines(
  fence: CodeFence,
  pulledRaw: readonly string[],
  original: CodeFence,
  localRaw: readonly string[],
): string[] | null {
  const pulled = fenceCodeText(fence);
  const local = fenceCodeText(original);
  if (pulled === local || collapsedByOldPush(local) !== pulled) return null;

  const pulledLines = pulled.split("\n");
  const out: string[] = [];
  let i = 0;
  for (const [j, line] of local.split("\n").entries()) {
    if (i < pulledLines.length && line === pulledLines[i]) {
      out.push(pulledRaw[i++]!);
    } else if (localRaw[j] === "" && localRaw[j - 1] === "" && pulledLines[i - 1] === "") {
      out.push(pulledRaw[i - 1]!);
    } else {
      return null;
    }
  }
  return i === pulledLines.length ? out : null;
}

/** v0.4.0 전의 push 가 코드에 한 일 — 펜스 줄의 줄바꿈까지 넣어, 이어진 빈 줄을 한 줄로. */
function collapsedByOldPush(code: string): string {
  return `\n${code}\n`.replace(/\n{3,}/g, "\n\n").slice(1, -1);
}

/** 받은 펜스의 언어 — Notion 이 돌려준 이름. */
function pulledLanguage(fence: CodeFence): string {
  return fence.info.trim().toLowerCase();
}

/**
 * 로컬 펜스가 받은 언어로 저장됐을 수 있나. 지금 push 가 보내는 이름이면 된다. 코드까지 같을 때는
 * javascript 도 받는다 — 이 버전 전의 push 는 정보 문자열을 그대로 보냈고, Notion 은 모르는 것을
 * javascript 로 저장했다. 이미 정식 이름인 펜스는 예전에도 그 이름이었으니 javascript 를 받지 않는다.
 */
function storedAs(original: CodeFence, language: string, sameCode: boolean): boolean {
  if (notionCodeLanguage(original.info) === language) return true;
  return sameCode && language === "javascript" && !isNotionLanguageInfo(original.info);
}

function pairFences(pulled: readonly CodeFence[], originals: readonly CodeFence[]): FencePair[] {
  const pairs = new Map<number, FencePair>();
  const used = new Set<number>();

  pulled.forEach((fence, i) => {
    const print = codeFingerprint(fence);
    const language = pulledLanguage(fence);
    const k = originals.findIndex(
      (original, j) =>
        !used.has(j) && codeFingerprint(original) === print && storedAs(original, language, true),
    );
    if (k === -1) return;
    used.add(k);
    pairs.set(i, { fence, original: originals[k]!, exact: true });
  });

  // 코드를 고친 블록 — 언어별로 남은 것끼리.
  const languages = new Set(pulled.map(pulledLanguage));
  for (const language of languages) {
    const rest = pulled
      .map((fence, i) => ({ fence, i }))
      .filter(({ fence, i }) => !pairs.has(i) && pulledLanguage(fence) === language);
    const candidates = originals
      .map((original, j) => ({ original, j }))
      .filter(({ original, j }) => !used.has(j) && storedAs(original, language, false));
    if (rest.length === 0 || candidates.length === 0) continue;

    if (rest.length === candidates.length) {
      rest.forEach(({ fence, i }, n) => {
        used.add(candidates[n]!.j);
        pairs.set(i, { fence, original: candidates[n]!.original, exact: false });
      });
      continue;
    }
    for (const { fence, i, original, j } of pairByOverlap(rest, candidates)) {
      used.add(j);
      pairs.set(i, { fence, original, exact: false });
    }
  }

  return [...pairs.values()];
}

/**
 * 같은 줄(공백 무시)이 있는 것끼리 짝짓는다 — 같은 줄이 많은 짝부터. 받은 순서대로 가장 가까운 것을
 * 고르면, 앞에 선 새 블록이 흔한 줄(`}` 같은) 하나로 고친 블록의 짝을 가로챈다. 같은 줄이 없으면
 * 다른 블록이다 — 짝짓지 않는다.
 */
function pairByOverlap(
  rest: ReadonlyArray<{ fence: CodeFence; i: number }>,
  candidates: ReadonlyArray<{ original: CodeFence; j: number }>,
): Array<{ fence: CodeFence; i: number; original: CodeFence; j: number }> {
  const theirs = candidates.map(({ original }) => lineCounts(original));
  const scored = rest.flatMap(({ fence, i }) => {
    const mine = lineCounts(fence);
    return candidates.map(({ original, j }, k) => {
      let shared = 0;
      for (const [line, count] of theirs[k]!) shared += Math.min(count, mine.get(line) ?? 0);
      return { fence, i, original, j, shared };
    });
  });
  scored.sort((a, b) => b.shared - a.shared || a.i - b.i || a.j - b.j);

  const taken = new Set<number>();
  const used = new Set<number>();
  return scored.filter((pair) => {
    if (pair.shared === 0 || taken.has(pair.i) || used.has(pair.j)) return false;
    taken.add(pair.i);
    used.add(pair.j);
    return true;
  });
}

function lineCounts(fence: CodeFence): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of fence.code) {
    const key = line.replace(/\s+/g, "");
    if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
