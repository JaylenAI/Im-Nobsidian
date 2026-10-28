/**
 * 증분 pull 의 삭제 확인 — 추적 중인 페이지 · 행을 차례로 몇 개씩 원격에 묻는다.
 *
 * Notion 은 지운 것을 목록으로 주지 않는다(2026-10-28 실측, Notion-Version 2025-09-03): search 는 휴지통
 * 페이지를 돌려주지 않고 `in_trash` · `archived` 를 넣으면 400 이다. data source 조회도 같다. 자식을 휴지통에
 * 넣어도 부모의 수정 시각은 그대로다. 그래서 증분 pull 은 삭제를 보지 못했고, 전체 대조(기본 1시간)가 돌 때까지
 * 다른 볼트에 지운 노트가 남았다. 필터를 단 DB 의 행은 전체 대조도 가르지 않아 영영 남았다.
 *
 * 남는 길은 페이지마다 묻는 것뿐이다. 매번 모두 물으면 증분이 전체 대조만큼 비싸지므로 한 번에 몇 개만 묻고,
 * 다음 pull 이 이어서 묻는다({@link DELETION_SWEEP_CURSOR_META_KEY}). 작은 볼트는 pull 마다 모두 묻는다.
 * 지워진 페이지를 찾으면 그 아래 추적 페이지는 차례와 상관없이 이어서 묻는다 — 부모를 휴지통에 넣으면 자식 ·
 * 손자도 `in_trash` 다(같은 실측). 폴더 하나를 지운 것이 여러 pull 에 나뉘어 보이지 않게.
 */
import type { SyncRecord } from "../types/sync.js";
import { compactNotionId } from "../utils/id.js";

/** 다음 증분 pull 이 이어서 물을 자리 — 마지막으로 물은 레코드의 압축 page id. */
export const DELETION_SWEEP_CURSOR_META_KEY = "deletion_sweep_cursor";

/**
 * 증분 pull 한 번이 묻는 레코드 수. 요청 간격(350ms)으로 약 5초다 — 증분 pull 이 빠른 까닭을 지키면서,
 * 이만큼 이하인 볼트는 pull 마다 모두 묻는다.
 */
export const DELETION_SWEEP_BUDGET = 15;

/** 물을 수 있는 레코드 — Notion 페이지가 있는 것. 차례는 압축 page id 순이다. */
function sweepable(records: readonly SyncRecord[], skip: ReadonlySet<string>): SyncRecord[] {
  return records
    .filter((r) => r.notionPageId !== null && !skip.has(idOf(r)))
    .sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
}

/**
 * 이번에 물을 레코드 — `cursor` 다음부터 `budget` 개, 끝에 닿으면 처음으로 돈다.
 *
 * @param skip 이번 pull 이 살아 있다고 이미 본 페이지(압축 id) — 묻지 않는다.
 * @returns `next` 는 다음 pull 의 커서(물을 것이 없으면 null). `complete` 면 이번에 모두 묻는다.
 */
export function sweepBatch(
  records: readonly SyncRecord[],
  cursor: string | null,
  skip: ReadonlySet<string>,
  budget = DELETION_SWEEP_BUDGET,
): { readonly batch: SyncRecord[]; readonly next: string | null; readonly complete: boolean } {
  const ordered = sweepable(records, skip);
  if (ordered.length === 0) return { batch: [], next: null, complete: true };
  if (ordered.length <= budget) {
    return { batch: ordered, next: idOf(ordered[ordered.length - 1]!), complete: true };
  }
  // 커서보다 뒤의 첫 자리 — 처음이거나 커서가 맨 끝이었으면 맨 앞부터 돈다.
  const start = Math.max(0, cursor === null ? 0 : ordered.findIndex((r) => idOf(r) > cursor));
  const batch = Array.from({ length: budget }, (_, i) => ordered[(start + i) % ordered.length]!);
  return { batch, next: idOf(batch[batch.length - 1]!), complete: false };
}

/**
 * 지워진 페이지 아래의 추적 레코드 — 부모(`notionParentId`)를 따라 모두. 그 페이지들도 휴지통에 있다.
 */
export function trackedDescendants(
  records: readonly SyncRecord[],
  goneIds: ReadonlySet<string>,
): SyncRecord[] {
  const gone = new Set(goneIds);
  const out: SyncRecord[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const record of records) {
      if (record.notionPageId === null || record.notionParentId === null) continue;
      const id = idOf(record);
      if (gone.has(id) || !gone.has(compactNotionId(record.notionParentId))) continue;
      gone.add(id);
      out.push(record);
      grew = true;
    }
  }
  return out;
}

function idOf(record: SyncRecord): string {
  return compactNotionId(record.notionPageId!);
}
