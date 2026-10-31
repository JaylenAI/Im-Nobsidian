import type { Conflict } from "../types/index.js";

/**
 * pull 이 원격 페이지 · 행 하나를 처리한 결과 — 페이지(오케스트레이터)와 DB 행(DatabaseSyncer)이
 * 같이 쓴다. 받은 것으로 세는 것은 `written` 뿐이다.
 *
 * - `written` — 원격을 받아 파일에 썼다. `sync` 는 이 파일을 이어지는 push 에서 뺀다 — 방금 받은
 *   글을 다시 올리지 않게.
 * - `unchanged` — 받을 것이 없었다(로컬과 같거나 원격이 지난 사본 그대로). 원격을 본 기록만 적었다.
 * - `skipped` — 로컬을 지키려고 받지 않았다(local-first). 이어지는 push 가 로컬을 올린다. 받은
 *   것으로 세면 `sync` 가 그 노트를 push 에서 빼, 로컬 편집이 `sync` 로는 영영 올라가지 않았다(F-h).
 * - `merged` — 양쪽이 다른 줄을 고쳐 합친 글을 썼다(merge 전략). 원격을 받았지만 로컬 편집이 남아 있어
 *   `sync` 는 이 파일을 push 에서 빼지 않는다 — 이어지는 push 가 합친 글을 올린다.
 * - `conflict` — 양쪽이 바뀌어 사용자가 고른다.
 *
 * `relinked` 는 상태 기록에 없던 같은 자리의 노트를 이 페이지와 다시 이었다는 뜻이다(P7) — 새로 받은 것으로 세지 않는다.
 */
export type PullOutcome = (
  | { readonly action: "written"; readonly path: string }
  | { readonly action: "unchanged"; readonly path?: string }
  | { readonly action: "skipped"; readonly path: string }
  | { readonly action: "merged"; readonly path: string }
  | { readonly action: "conflict"; readonly path: string; readonly conflict: Conflict }
) & { readonly relinked?: true };
