/**
 * 「복제」 해소가 남기는 원격 사본(`이름.conflict.md`)의 이름.
 *
 * 사본은 사용자가 견주어 보고 손으로 합치라고 두는 것이다. 예전에는 다음 push 가 이것을 새 노트로 보고
 * Notion 에 새 페이지로 올렸다 — 원격 본문이 Notion 에 한 벌 더 생겼다. 변경 감지는 이 이름의 추적하지
 * 않는 파일을 건너뛴다. 올리고 싶으면 이름을 바꾸면 된다.
 */
const CONFLICT_COPY_SUFFIX = ".conflict";

/** `노트.md` 의 사본 경로 — `노트.conflict.md`. */
export function conflictCopyPath(path: string): string {
  const ext = path.endsWith(".md") ? ".md" : "";
  return `${path.slice(0, path.length - ext.length)}${CONFLICT_COPY_SUFFIX}${ext}`;
}

/** 「복제」 해소가 남긴 사본의 이름인가. */
export function isConflictCopyPath(path: string): boolean {
  return path.endsWith(`${CONFLICT_COPY_SUFFIX}.md`);
}
