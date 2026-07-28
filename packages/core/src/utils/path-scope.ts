/**
 * `--path` 범위 판정 — 볼트 상대경로가 사용자가 지정한 범위 안에 있는지.
 *
 * 단순 `startsWith` 는 **경로 조각 경계를 보지 않아** 범위를 넘겨 짚는다.
 * `--path Notes` 가 `Notes-archive/비밀.md` · `Notes백업.md` 까지 끌어와, 사용자가
 * 의도한 폴더 밖 파일을 push/pull 대상에 올린다(범위 지정의 의미가 무너진다).
 *
 * 규칙은 셋뿐이다.
 *   1. 완전 일치        — `--path a/b.md` ↔ `a/b.md`
 *   2. 폴더 하위        — `--path a` ↔ `a/b.md` (경계 `/` 를 반드시 소비)
 *   3. 그 외는 불일치   — `--path a` ↔ `ab.md` ✗
 *
 * 사용자가 `--path a/` 처럼 슬래시를 붙여 쓰는 경우도 같은 범위로 본다.
 */
export function matchesPathScope(path: string, scope: string): boolean {
  const prefix = scope.endsWith("/") ? scope.slice(0, -1) : scope;
  if (prefix === "") return true;
  if (path === prefix) return true;
  return path.startsWith(`${prefix}/`);
}

/** 범위 목록 중 하나라도 걸리면 true. 목록이 비어 있으면(범위 미지정) 항상 true. */
export function inAnyPathScope(path: string, scopes: readonly string[] | undefined): boolean {
  if (!scopes || scopes.length === 0) return true;
  return scopes.some((s) => matchesPathScope(path, s));
}
