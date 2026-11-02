/**
 * 자동 발견한 DB 목록 — 상태 메타에 두는 표현과 그것을 읽는 법.
 *
 * pull 이 찾아 등록하고(`DatabaseDiscovery`), 원격 감지 · 완전성 대조 · 폴더 이동이 읽는다.
 * 이 세 메타 키와 그 해석은 이 파일만 안다 — 읽는 곳마다 표현을 다시 해석하지 않게.
 */
import type { IStateDB } from "../state/state-db-interface.js";

/**
 * 부모 페이지를 볼트에 두지 않는 DB(루트 바로 아래 · 부모를 모르는 DB)를 받는 폴더. 이 폴더는 Notion 에서 페이지가
 * 아니다 — push 는 이 폴더를 페이지로 만들지 않고 그 안의 DB 를 루트 아래에 만든다(ADR-036).
 */
export const ROOT_DATABASES_FOLDER = "databases";

/** 자동 발견된 DB 1개의 동기화 설정 — 상태 메타 `discovered_dbs` 에 목록으로 둔다. */
export interface DiscoveredDbConfig {
  databaseId: string;
  localFolder: string;
  /** push 가 만든 DB 의 제목 속성 — 적어 두기만 하고 읽는 곳은 없다. 발견한 DB · 설정의 DB 에는 없다. */
  titleProperty?: string;
}

/** 자동 발견 DB 목록을 보존하는 상태 메타 키. */
export const DISCOVERED_DBS_META_KEY = "discovered_dbs";

/**
 * 하위 DB 블록 스캔을 마친 시각을 두는 상태 메타 키. 스캔은 추적 페이지마다 요청 1회라 처음 한 번만
 * 한다 — 그 뒤에 생긴 DB 는 받은 페이지의 본문(`<database>` 태그)으로 찾는다. 예전에는 «발견한 DB
 * 캐시가 비었는가» 로 가려, DB 가 하나도 없는 볼트는 원격이 그대로여도 pull 마다 모든 페이지를 다시
 * 훑었다.
 */
export const DISCOVERY_SCANNED_META_KEY = "discovery_scanned_at";

/**
 * 다음 pull 이 모든 페이지를 훑어 하위 DB 를 찾는가 — 찾아 둔 DB 가 없고 훑은 적도 없다(첫 pull · 상태 DB 를 잃은 볼트).
 */
export function discoveryScanPending(stateDb: Pick<IStateDB, "getMeta">): boolean {
  return (
    parseDiscoveredDbs(stateDb.getMeta(DISCOVERED_DBS_META_KEY)).length === 0 &&
    !stateDb.getMeta(DISCOVERY_SCANNED_META_KEY)
  );
}

/** 접근 불가 DB denylist 를 보존하는 상태 메타 키. */
export const INACCESSIBLE_DBS_META_KEY = "inaccessible_dbs";

/** linked view 컨테이너 → 원본 DB 매핑을 보존하는 상태 메타 키(nohyph → nohyph). */
export const LINKED_DBS_META_KEY = "linked_dbs";

/** 자동 발견 DB 목록. 없거나 깨졌으면 빈 목록 — 설정 · 볼트 추적분만으로 계속한다. */
export function parseDiscoveredDbs(raw: string | null): DiscoveredDbConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as DiscoveredDbConfig[]) : [];
  } catch {
    return [];
  }
}

/** 접근 불가 DB denylist 를 상태 메타에서 로드한다(하이픈 정규화). */
export function loadInaccessibleDbIds(stateDb: IStateDB): Set<string> {
  const raw = stateDb.getMeta(INACCESSIBLE_DBS_META_KEY);
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw) as string[];
    return new Set(arr.map((id) => id.replace(/-/g, "")));
  } catch {
    return new Set();
  }
}

/** linked view 컨테이너 → 원본 DB 매핑을 상태 메타에서 로드한다(nohyph → nohyph). */
export function loadLinkedDbMap(stateDb: IStateDB): Map<string, string> {
  const raw = stateDb.getMeta(LINKED_DBS_META_KEY);
  if (!raw) return new Map();
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj).map(([k, v]) => [k.replace(/-/g, ""), v.replace(/-/g, "")]));
  } catch {
    return new Map();
  }
}
