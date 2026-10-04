import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { codeFingerprint } from "../code-fence.js";
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
    for (const { fence, original, exact } of pairFences(pulled, originals)) {
      const bar = exact ? original.bar : fence.bar;
      lines[fence.open] = fence.lead + bar + original.info;
      if (exact) lines[fence.close!] = fence.closeLead! + original.closeBar!;
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
