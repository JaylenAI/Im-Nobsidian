import { isMarkdownPath, stripMarkdownExtension } from "../utils/markdown-path.js";

/**
 * 「복제」 해소가 남기는 원격 사본(`이름.conflict.md`)의 이름.
 *
 * 사본은 사용자가 견주어 보고 손으로 합치라고 두는 것이다. 예전에는 다음 push 가 이것을 새 노트로 보고
 * Notion 에 새 페이지로 올렸다 — 원격 본문이 Notion 에 한 벌 더 생겼다. 변경 감지는 이 이름의 추적하지
 * 않는 파일을 건너뛴다. 올리고 싶으면 이름을 바꾸면 된다.
 */
const CONFLICT_COPY_SUFFIX = ".conflict";

/** `노트.md` 의 `nth` 번째 사본 경로 — `노트.conflict.md`, 둘째부터 `노트 2.conflict.md`. */
export function conflictCopyPath(path: string, nth = 1): string {
  const name = stripMarkdownExtension(path);
  const numbered = nth > 1 ? `${name} ${nth}` : name;
  return `${numbered}${CONFLICT_COPY_SUFFIX}${path.slice(name.length)}`;
}

/**
 * 볼트에 아직 없는 사본 경로. 같은 노트를 다시 「복제」 로 풀면 예전에는 앞 사본을 덮었다 — 사용자가 견주며
 * 손대던 사본의 글이 말없이 사라졌다. 앞 사본은 그대로 두고 다음 번호를 쓴다.
 */
export async function freeConflictCopyPath(
  path: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  for (let nth = 1; ; nth++) {
    const candidate = conflictCopyPath(path, nth);
    if (!(await exists(candidate))) return candidate;
  }
}

/** 「복제」 해소가 남긴 사본의 이름인가. */
export function isConflictCopyPath(path: string): boolean {
  return isMarkdownPath(path) && stripMarkdownExtension(path).endsWith(CONFLICT_COPY_SUFFIX);
}
