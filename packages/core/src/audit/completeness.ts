/**
 * DB 완결성 게이트 — "원격에 있는 행이 볼트에도 전부 있는가"를 대조한다.
 *
 * ## 왜 필요한가 (R11)
 *
 * 기존 게이트는 전부 **멱등성**(같은 입력에 같은 출력)을 본다 — 해시 불일치 0, repull
 * 바이트 동일, churn 0. 그런데 멱등성은 *체계적 미발견*을 구조적으로 잡지 못한다:
 * 디스커버리가 매번 **같은 행을 똑같이 놓치면** 두 번째 pull 도 첫 번째와 동일한
 * 결과를 내므로 churn 은 0 이고 해시도 전부 일치한다. 실제로 2026-07-17 pull 은 DB 행
 * 296개를 침묵 유실한 채 `audit-vault 결함 0 · 해시 불일치 0 · byte-identical repull`
 * 을 전부 통과했다. "안 바뀐다"와 "빠짐없다"는 다른 성질이고, 후자를 보는 게이트가
 * 없었던 것이다.
 *
 * 이 모듈은 후자만 본다. 원격 행 id 집합과 볼트가 추적 중인 db-row id 집합을 직접
 * 대조해, 어느 쪽에만 있는지를 센다. 카운트가 아니라 **집합**을 비교하는 이유는
 * 카운트만 보면 "1건 미발견 + 1건 잔재"가 상쇄돼 통과하기 때문이다.
 *
 * ## 범위와 한계
 *
 * 볼트가 **아는** database 에 대해 "그 DB 의 모든 행이 있는가"를 보장한다. database
 * 자체를 통째로 못 찾은 경우는 볼트에 흔적이 없어 여기서 알 수 없으므로, 호출부가
 * 설정/디스커버리가 아는 database id 를 {@link CompletenessOptions.databaseIds} 로
 * 넘겨 그 구멍까지 덮는다(행 0개로 대조되어 미발견이 그대로 드러난다).
 *
 * 원격 열거는 {@link CompletenessRemoteSource.queryAllDatabasePages} — 전 data source
 * 를 순회하는 SSOT — 하나만 쓴다. 여기서 별도 쿼리를 짜면 검증기가 피검증 대상과 다른
 * 열거 규칙을 갖게 돼, 게이트가 통과해도 실제 pull 은 놓치는 상황이 생긴다.
 */

import { compactNotionId } from "../utils/id.js";

/** 원격 행 열거 — {@link NotionClient} 가 그대로 만족한다(전 data source 순회 SSOT). */
export interface CompletenessRemoteSource {
  queryAllDatabasePages(databaseId: string, filter?: unknown): Promise<Array<{ id: string }>>;
}

/** 볼트가 추적 중인 레코드 열거 — {@link IStateDB} 가 그대로 만족한다. */
export interface CompletenessLocalSource {
  getAll(): ReadonlyArray<{
    readonly notionPageId: string | null;
    readonly notionParentId: string | null;
    readonly fileType: string;
  }>;
}

/** database 1개의 대조 결과. */
export interface DatabaseCompleteness {
  /** 대조 대상 database id(입력 표기 그대로). */
  readonly databaseId: string;
  /** 원격 행 수(전 data source 합·page id 디듀프 후). */
  readonly remoteRows: number;
  /** 볼트가 이 DB 소속으로 추적 중인 db-row 수. */
  readonly localRows: number;
  /** 원격에만 있는 행 id — **침묵 미발견**. 비어야 정상. */
  readonly missingIds: readonly string[];
  /** 볼트에만 있는 행 id — 원격 삭제 잔재/부모 오배치. 비어야 정상. */
  readonly extraIds: readonly string[];
}

/** 원격 열거가 실패한 database — 결과를 "이상 없음"으로 접지 않기 위해 따로 싣는다. */
export interface CompletenessFailure {
  readonly databaseId: string;
  readonly error: string;
}

/** {@link verifyDatabaseCompleteness} 결과. */
export interface CompletenessReport {
  /** database 별 대조 결과(입력 순서). */
  readonly databases: readonly DatabaseCompleteness[];
  /** 원격 열거 실패 목록. 하나라도 있으면 `complete` 는 false. */
  readonly failures: readonly CompletenessFailure[];
  /** 대조에 성공한 database 들의 원격 행 총합. */
  readonly remoteTotal: number;
  /** 같은 database 들의 볼트 db-row 총합. */
  readonly localTotal: number;
  /** 미발견·잔재·조회 실패가 모두 0. */
  readonly complete: boolean;
}

export interface CompletenessOptions {
  /**
   * 볼트에 행이 하나도 없어도 반드시 대조할 database id(설정 `notion.databases[]` ·
   * 디스커버리 캐시 등). 통째로 미발견된 DB 를 드러내는 유일한 경로다.
   */
  readonly databaseIds?: readonly string[];
}

/** db-row 레코드를 부모 database(정규 id) 별로 묶어 행 page id 집합을 만든다. */
function groupLocalRowsByDatabase(local: CompletenessLocalSource): Map<string, Set<string>> {
  const byDb = new Map<string, Set<string>>();
  for (const record of local.getAll()) {
    if (record.fileType !== "db-row") continue;
    if (!record.notionParentId || !record.notionPageId) continue;
    const dbKey = compactNotionId(record.notionParentId);
    let rows = byDb.get(dbKey);
    if (!rows) {
      rows = new Set<string>();
      byDb.set(dbKey, rows);
    }
    rows.add(compactNotionId(record.notionPageId));
  }
  return byDb;
}

/**
 * 원격 행 집합과 볼트 db-row 집합을 database 별로 대조한다.
 *
 * 대조 대상 = 볼트가 db-row 를 추적 중인 모든 database ∪
 * {@link CompletenessOptions.databaseIds}. 한 database 의 열거가 실패해도 나머지는
 * 계속 대조하고, 실패는 {@link CompletenessReport.failures} 로 비침묵 보고한다.
 */
export async function verifyDatabaseCompleteness(
  remote: CompletenessRemoteSource,
  local: CompletenessLocalSource,
  options?: CompletenessOptions,
): Promise<CompletenessReport> {
  const localRowsByDb = groupLocalRowsByDatabase(local);

  // 대조 순서/표기는 "호출부가 지정한 것 먼저, 그 다음 볼트가 아는 것" 으로 고정한다.
  // 같은 DB 가 양쪽에 있으면 정규 id 로 한 번만 본다.
  const targets: Array<{ databaseId: string; key: string }> = [];
  const seen = new Set<string>();
  for (const id of options?.databaseIds ?? []) {
    const key = compactNotionId(id);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ databaseId: id, key });
  }
  for (const key of localRowsByDb.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ databaseId: key, key });
  }

  const databases: DatabaseCompleteness[] = [];
  const failures: CompletenessFailure[] = [];
  let remoteTotal = 0;
  let localTotal = 0;

  for (const target of targets) {
    const localIds = localRowsByDb.get(target.key) ?? new Set<string>();

    let remoteIds: Set<string>;
    try {
      const pages = await remote.queryAllDatabasePages(target.databaseId);
      remoteIds = new Set(pages.map((p) => compactNotionId(p.id)));
    } catch (error) {
      failures.push({
        databaseId: target.databaseId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const missingIds = [...remoteIds].filter((id) => !localIds.has(id));
    const extraIds = [...localIds].filter((id) => !remoteIds.has(id));

    remoteTotal += remoteIds.size;
    localTotal += localIds.size;
    databases.push({
      databaseId: target.databaseId,
      remoteRows: remoteIds.size,
      localRows: localIds.size,
      missingIds,
      extraIds,
    });
  }

  const complete =
    failures.length === 0 &&
    databases.every((d) => d.missingIds.length === 0 && d.extraIds.length === 0);

  return { databases, failures, remoteTotal, localTotal, complete };
}

// ─── 페이지 완결성 (R12-C) ───────────────────────────────────────────────────

/**
 * 원격 페이지 열거 — {@link NotionClient} 가 그대로 만족한다.
 *
 * DB 쪽과 달리 여기서는 **일부러 pull 과 다른 열거를 쓴다**. DB 행은 열거 방법이 하나뿐이라
 * 검증기가 다른 규칙을 쓰면 게이트가 통과해도 pull 은 놓치는 상황이 생기지만, 페이지는
 * 열거 경로가 둘(직접 순회 · search)이고 **둘이 같은 집합을 내지 않는다**는 게 애초의
 * 결함이다(R12-A). pull 이 어느 경로로 돌았든 독립된 두 번째 열거와 대조해야 의미가 있다.
 */
export interface PageCompletenessRemoteSource {
  getPagesUnderRootViaSearch(rootId: string): Promise<Array<{ id: string }>>;
}

/** {@link verifyPageCompleteness} 결과. */
export interface PageCompletenessReport {
  /** 원격(search 열거) root 하위 페이지 수. */
  readonly remotePages: number;
  /** 볼트가 추적 중인 페이지 수(db-row 제외). */
  readonly vaultPages: number;
  /** 원격에만 있는 페이지 id — **침묵 미발견**. 비어야 정상. */
  readonly missingIds: readonly string[];
  /**
   * 볼트에만 있는 페이지 id — **정보성**(판정에 쓰지 않는다).
   *
   * DB 행과 달리 페이지는 볼트에만 있는 게 정상일 수 있다: 아직 push 하지 않은 로컬 노트,
   * root 페이지 자신(search 열거는 root 를 제외한다), search 색인이 아직 못 따라온 신규
   * 페이지. 이걸 실패로 접으면 게이트가 거짓 적색을 내며 신뢰를 잃는다.
   */
  readonly localOnlyIds: readonly string[];
  /** 열거 실패 사유. 있으면 `complete` 는 false(실패를 통과로 접지 않는다). */
  readonly error?: string;
  /** 미발견 0 이고 열거도 성공. */
  readonly complete: boolean;
}

/** {@link SyncOrchestrator.verifyCompleteness} 결과 — DB 와 페이지 대조를 한 판정으로 묶는다. */
export interface VaultCompletenessReport {
  readonly databases: CompletenessReport;
  /** 페이지 모드에서만 채워진다. DB 모드에는 root 서브트리가 없어 `null`. */
  readonly pages: PageCompletenessReport | null;
  /** 두 대조가 모두 통과. */
  readonly complete: boolean;
}

/**
 * 원격 root 하위 페이지 집합과 볼트가 추적 중인 페이지 집합을 대조한다.
 *
 * 볼트 쪽은 `fileType !== "db-row"` 로 고른다 — 페이지형 타입을 열거하면
 * (`file`·`folder-note`·`folder-only`) 새 타입이 생겼을 때 한쪽만 낡아 조용히 게이트를
 * 빠져나간다. "행이 아닌 것은 전부 페이지"가 이 대조가 실제로 뜻하는 바다.
 */
export async function verifyPageCompleteness(
  remote: PageCompletenessRemoteSource,
  local: CompletenessLocalSource,
  rootPageId: string,
): Promise<PageCompletenessReport> {
  const localIds = new Set<string>();
  for (const record of local.getAll()) {
    if (record.fileType === "db-row") continue;
    if (!record.notionPageId) continue;
    localIds.add(compactNotionId(record.notionPageId));
  }

  let remoteIds: Set<string>;
  try {
    const pages = await remote.getPagesUnderRootViaSearch(rootPageId);
    remoteIds = new Set(pages.map((p) => compactNotionId(p.id)));
  } catch (error) {
    return {
      remotePages: 0,
      vaultPages: localIds.size,
      missingIds: [],
      localOnlyIds: [],
      error: error instanceof Error ? error.message : String(error),
      complete: false,
    };
  }

  const missingIds = [...remoteIds].filter((id) => !localIds.has(id));
  const localOnlyIds = [...localIds].filter((id) => !remoteIds.has(id));

  return {
    remotePages: remoteIds.size,
    vaultPages: localIds.size,
    missingIds,
    localOnlyIds,
    complete: missingIds.length === 0,
  };
}
