import { notionIdsEqual } from "./id.js";

/** {@link repairDbFolderCollisions} 입력의 최소 형태 — 발견 DB 캐시 항목. */
export interface DbFolderConfig {
  databaseId: string;
  localFolder: string;
}

/**
 * 발견 DB 의 로컬 폴더를 충돌 없이 결정한다.
 *
 * 같은 부모 페이지 아래 **같은 제목의 인라인 DB 가 여럿** 있으면(만다라트 핵심목표,
 * 스위치온 프로필/체중/단계 등 — E2E 실측 22쌍) 제목 기반 폴더 유도가 같은 경로로
 * 수렴한다. 폴더를 공유하면
 *   ① `.base`/`.notion.json` 을 서로 덮어써 마지막 승자의 것만 남고(행 소유 DB 와
 *      메타데이터 DB 가 어긋남), 같은 pull 안에서 사이드카가 핑퐁해 degrade 로그가
 *      매 pull 반복되며
 *   ② 두 DB 의 행 파일이 한 폴더에 섞여 Bases 뷰에 중복 행처럼 보인다.
 *
 * {@link resolveDbRowPath} 와 동일한 규칙으로 — 폴더가 *다른* DB 에 점유되어 있으면
 * DB ID 조각을 8→16→32 로 넓혀 유일 폴더를 찾는다. ID 는 불변이므로 항상 같은
 * 폴더로 수렴하고, 캐시에 기록된 뒤에는 재계산 없이 고정된다.
 *
 * @param folder  제목 기반으로 유도된 폴더 경로
 * @param dbId    대상 DB ID (하이픈 유무 무관)
 * @param ownerOf 후보 폴더의 현재 점유 DB ID 를 돌려주는 조회 함수(없으면 null)
 */
export function resolveDbFolderPath(
  folder: string,
  dbId: string,
  ownerOf: (folder: string) => string | null,
): string {
  const usable = (candidate: string): boolean => {
    const owner = ownerOf(candidate);
    return owner === null || notionIdsEqual(owner, dbId);
  };

  if (usable(folder)) return folder;

  const raw = dbId.replace(/-/g, "");
  for (const len of [8, 16, 32]) {
    const candidate = `${folder} (${raw.slice(0, len)})`;
    if (usable(candidate)) return candidate;
  }

  // 전체 ID(32 글자)는 전역 유일하므로 위 루프에서 반드시 반환된다(방어적 폴백).
  return `${folder} (${raw})`;
}

/**
 * 발견 DB 캐시에 이미 들어 있는 폴더 충돌(구버전 산출)을 제자리에서 수리한다.
 *
 * 배열 순서(캐시 저장 순서 — 안정적)대로 첫 점유자가 원 폴더를 유지하고, 이후
 * 충돌 항목은 {@link resolveDbFolderPath} 로 재배치한다. 결정적이므로 수리 결과가
 * 캐시에 저장된 뒤에는 다음 pull 부터 no-op 이다(멱등).
 *
 * @param configs      발견 DB 설정 목록 — localFolder 를 제자리 수정한다
 * @param takenFolders 발견 캐시 밖에서 이미 점유된 폴더(사용자 설정 DB 등) → 점유 DB ID
 * @returns 재배치된 항목 수
 */
export function repairDbFolderCollisions(
  configs: DbFolderConfig[],
  takenFolders?: ReadonlyMap<string, string>,
): number {
  const owner = new Map<string, string>(takenFolders ?? []);
  let repaired = 0;
  for (const config of configs) {
    const resolved = resolveDbFolderPath(
      config.localFolder,
      config.databaseId,
      (f) => owner.get(f) ?? null,
    );
    if (resolved !== config.localFolder) {
      config.localFolder = resolved;
      repaired++;
    }
    owner.set(resolved, config.databaseId);
  }
  return repaired;
}

/**
 * 경로가 DB 폴더 **직속(depth 1)** 행 파일인지 검사한다 — `selectDbRowFiles` 와 동일
 * 규칙의 단건 버전. 폴더 충돌 수리(F24)로 localFolder 가 분리된 뒤, 옛 공유 폴더를
 * 가리키는 행 레코드를 "재배치 필요"로 판정하는 데 쓴다.
 */
export function isDirectDbRowPath(localFolder: string, path: string): boolean {
  const prefix = localFolder.endsWith("/") ? localFolder : `${localFolder}/`;
  if (!path.startsWith(prefix)) return false;
  const rel = path.slice(prefix.length);
  return rel.length > 0 && !rel.includes("/");
}
