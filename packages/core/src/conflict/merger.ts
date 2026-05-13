export interface MergeResult {
  readonly success: boolean;
  readonly merged: string;
  readonly conflicts: MergeConflictRegion[];
}

export interface MergeConflictRegion {
  readonly localLines: string[];
  readonly remoteLines: string[];
}

export function threeWayMerge(base: string, local: string, remote: string): MergeResult {
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");

  const localDiff = computeDiff(baseLines, localLines);
  const remoteDiff = computeDiff(baseLines, remoteLines);

  const merged: string[] = [];
  const conflicts: MergeConflictRegion[] = [];
  let success = true;

  let baseIdx = 0;

  while (baseIdx < baseLines.length || localDiff.length > 0 || remoteDiff.length > 0) {
    const localChange = localDiff.find((d) => d.baseStart === baseIdx);
    const remoteChange = remoteDiff.find((d) => d.baseStart === baseIdx);

    if (localChange && remoteChange) {
      if (arraysEqual(localChange.newLines, remoteChange.newLines)) {
        merged.push(...localChange.newLines);
      } else {
        success = false;
        conflicts.push({
          localLines: localChange.newLines,
          remoteLines: remoteChange.newLines,
        });
        merged.push("<<<<<<< LOCAL");
        merged.push(...localChange.newLines);
        merged.push("=======");
        merged.push(...remoteChange.newLines);
        merged.push(">>>>>>> REMOTE");
      }

      baseIdx = Math.max(localChange.baseEnd, remoteChange.baseEnd);
      localDiff.splice(localDiff.indexOf(localChange), 1);
      remoteDiff.splice(remoteDiff.indexOf(remoteChange), 1);
    } else if (localChange) {
      merged.push(...localChange.newLines);
      baseIdx = localChange.baseEnd;
      localDiff.splice(localDiff.indexOf(localChange), 1);
    } else if (remoteChange) {
      merged.push(...remoteChange.newLines);
      baseIdx = remoteChange.baseEnd;
      remoteDiff.splice(remoteDiff.indexOf(remoteChange), 1);
    } else {
      if (baseIdx < baseLines.length) {
        merged.push(baseLines[baseIdx]!);
      }
      baseIdx++;
    }
  }

  return {
    success,
    merged: merged.join("\n"),
    conflicts,
  };
}

interface DiffHunk {
  baseStart: number;
  baseEnd: number;
  newLines: string[];
}

function computeDiff(base: string[], modified: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let baseIdx = 0;
  let modIdx = 0;

  while (baseIdx < base.length && modIdx < modified.length) {
    if (base[baseIdx] === modified[modIdx]) {
      baseIdx++;
      modIdx++;
    } else {
      const hunkStart = baseIdx;
      const newLines: string[] = [];

      while (modIdx < modified.length && base[baseIdx] !== modified[modIdx]) {
        newLines.push(modified[modIdx]!);
        modIdx++;
      }
      baseIdx++;

      hunks.push({ baseStart: hunkStart, baseEnd: baseIdx, newLines });
    }
  }

  if (modIdx < modified.length) {
    hunks.push({
      baseStart: baseIdx,
      baseEnd: base.length,
      newLines: modified.slice(modIdx),
    });
  }

  return hunks;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, idx) => val === b[idx]);
}
