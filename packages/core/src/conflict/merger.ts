export interface MergeResult {
  readonly success: boolean;
  readonly merged: string;
  readonly conflicts: MergeConflictRegion[];
}

export interface MergeConflictRegion {
  readonly localLines: string[];
  readonly remoteLines: string[];
}

/** base 한 쪽(local 또는 remote)의 변경 조각. base[baseStart, baseEnd) 구간을 content 로 치환. */
interface Hunk {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly content: string[];
  /** 0 = local, 2 = remote (정렬 시 동률이면 local 우선). */
  readonly side: 0 | 2;
}

/**
 * 3-way 병합 (diff3). base 를 공통 조상으로 보고 local/remote 의 변경을 합친다.
 *
 * 표준 diff3 알고리즘:
 *   1. base↔local, base↔remote 각각의 LCS 로 "변경 조각(hunk)"을 추출한다.
 *      (hunk = base 의 어떤 구간 [baseStart, baseEnd) 을 새 내용으로 치환·삭제·삽입)
 *   2. 모든 hunk 를 base 위치순으로 정렬하고, **base 구간이 겹치는** hunk 들을
 *      하나의 region 으로 묶는다. 겹치지 않는 hunk 사이의 base 줄은 양쪽 공통이므로 그대로 출력.
 *   3. 각 region 에서 local/remote 가 만들어낸 내용을 비교해 판정한다.
 *      - local 결과 == base       → local 미변경 → remote 채택
 *      - remote 결과 == base      → remote 미변경 → local 채택
 *      - local 결과 == remote 결과 → 동일 변경 → 한쪽 채택
 *      - 그 외                     → 충돌 (양쪽이 같은 구간을 다르게 변경)
 *
 * 핵심은 hunk 의 base 구간이 **실제로 겹칠 때만** 충돌로 본다는 점이다. 서로 다른(인접
 * 포함) 줄을 고친 삽입·삭제·수정은 충돌 없이 합쳐진다. (이전 단순 라인-치환 구현은
 * 삽입/삭제를 오정렬해 거짓 충돌을 만들거나 무한 루프에 빠질 수 있었다.)
 */
export function threeWayMerge(base: string, local: string, remote: string): MergeResult {
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");

  const hunks = [
    ...computeHunks(baseLines, localLines, 0),
    ...computeHunks(baseLines, remoteLines, 2),
  ];
  // base 시작 위치 오름차순, 동률이면 local(0) 먼저.
  hunks.sort((a, b) => a.baseStart - b.baseStart || a.side - b.side);

  const merged: string[] = [];
  const conflicts: MergeConflictRegion[] = [];
  let cursor = 0; // 다음에 출력할 base 인덱스.
  let i = 0;

  while (i < hunks.length) {
    const first = hunks[i]!;
    // region 앞쪽의 공통(안정) base 줄을 그대로 출력.
    if (first.baseStart > cursor) {
      merged.push(...baseLines.slice(cursor, first.baseStart));
    }

    const regionStart = first.baseStart;
    let regionEnd = first.baseEnd;
    const group: Hunk[] = [first];
    i++;

    // base 구간이 겹치는 hunk 들을 한 region 으로 흡수.
    // - 일반 겹침: 다음 hunk 의 시작이 regionEnd 보다 앞(strict).
    // - 같은 지점의 순수 삽입(regionEnd === regionStart): 시작 위치가 같으면 함께 묶는다
    //   (양쪽이 같은 자리에 삽입 → 동일하면 1회, 다르면 충돌).
    while (i < hunks.length) {
      const next = hunks[i]!;
      const overlaps =
        next.baseStart < regionEnd || (regionEnd === regionStart && next.baseStart === regionStart);
      if (!overlaps) break;
      regionEnd = Math.max(regionEnd, next.baseEnd);
      group.push(next);
      i++;
    }

    const baseRegion = baseLines.slice(regionStart, regionEnd);
    const localRegion = applyHunks(baseLines, group, 0, regionStart, regionEnd);
    const remoteRegion = applyHunks(baseLines, group, 2, regionStart, regionEnd);

    if (arraysEqual(localRegion, baseRegion)) {
      merged.push(...remoteRegion); // local 미변경 → remote 채택
    } else if (arraysEqual(remoteRegion, baseRegion)) {
      merged.push(...localRegion); // remote 미변경 → local 채택
    } else if (arraysEqual(localRegion, remoteRegion)) {
      merged.push(...localRegion); // 동일 변경
    } else {
      conflicts.push({ localLines: localRegion, remoteLines: remoteRegion });
      merged.push("<<<<<<< LOCAL");
      merged.push(...localRegion);
      merged.push("=======");
      merged.push(...remoteRegion);
      merged.push(">>>>>>> REMOTE");
    }

    cursor = regionEnd;
  }

  // 마지막 region 이후의 공통 base 줄.
  if (cursor < baseLines.length) {
    merged.push(...baseLines.slice(cursor));
  }

  return {
    success: conflicts.length === 0,
    merged: merged.join("\n"),
    conflicts,
  };
}

/**
 * base 와 modified 의 LCS 매칭을 기준으로 변경 조각(hunk) 목록을 만든다.
 * 매칭되지 않은(=변경된) base 구간과 그에 대응하는 modified 구간을 한 hunk 로 묶는다.
 */
function computeHunks(base: string[], modified: string[], side: 0 | 2): Hunk[] {
  const matches = lcsMatches(base, modified); // [baseIdx, modIdx] 오름차순
  const hunks: Hunk[] = [];

  let prevBase = -1;
  let prevMod = -1;
  const emitGap = (curBase: number, curMod: number): void => {
    const baseLen = curBase - (prevBase + 1);
    const modLen = curMod - (prevMod + 1);
    if (baseLen > 0 || modLen > 0) {
      hunks.push({
        baseStart: prevBase + 1,
        baseEnd: curBase,
        content: modified.slice(prevMod + 1, curMod),
        side,
      });
    }
  };

  for (const [b, m] of matches) {
    emitGap(b, m);
    prevBase = b;
    prevMod = m;
  }
  emitGap(base.length, modified.length); // 마지막 매칭 이후 꼬리.

  return hunks;
}

/**
 * region [regionStart, regionEnd) 에 대해 한 쪽(side)이 만들어낸 내용을 재구성한다.
 * 해당 side 의 hunk 는 base 를 치환하고, hunk 가 없는 base 줄은 그대로 복사한다.
 * region 경계는 항상 hunk 경계와 정렬되므로 hunk 가 region 을 가로지르지 않는다.
 */
function applyHunks(
  baseLines: string[],
  group: Hunk[],
  side: 0 | 2,
  regionStart: number,
  regionEnd: number,
): string[] {
  const out: string[] = [];
  let b = regionStart;
  for (const hunk of group) {
    if (hunk.side !== side) continue;
    if (hunk.baseStart > b) out.push(...baseLines.slice(b, hunk.baseStart));
    out.push(...hunk.content);
    b = hunk.baseEnd;
  }
  if (b < regionEnd) out.push(...baseLines.slice(b, regionEnd));
  return out;
}

/**
 * a 와 b 의 LCS 매칭 쌍 [aIndex, bIndex] 을 a 인덱스 오름차순으로 반환한다.
 * 라인 단위 비교(보통 수백~수천 줄)라 O(n·m) DP 로 충분하다.
 */
function lcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;

  // dp[i][j] = a[i..], b[j..] 의 LCS 길이. 행마다 Uint32Array 로 메모리 절약.
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);

  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    const ai = a[i];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = ai === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      matches.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }

  return matches;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, idx) => val === b[idx]);
}
