import { notionIdsEqual } from "./id.js";

/** {@link resolveDbRowPath} 가 경로 점유 여부를 조회하기 위한 최소 레코드 형태. */
export interface PathOwner {
  notionPageId: string | null;
}

/** {@link selectDbRowFiles} 입력의 최소 형태(경로만 필요). */
export interface VaultPathRef {
  readonly path: string;
}

/**
 * DB 폴더의 **직속(depth 1)** 행 파일만 고른다 — 중첩 하위 폴더는 제외한다.
 *
 * DB 행은 항상 `localFolder/<name>.md` 로 **평탄하게** 기록된다({@link resolveDbRowPath}).
 * 하위 폴더(`localFolder/SubDB/...`)는 **별도 child_database** 이거나 자식 페이지 본문이라
 * 부모 DB 의 행이 아니다. `path.startsWith(prefix)` 단순 매칭은 이 중첩 파일까지 부모 행으로
 * **오포함(over-inclusion)** 한다:
 *   - 뷰(I9): 하위 DB 의 행이 부모 갤러리/테이블/보드에 카드로 새어 든다.
 *   - push: 하위 DB 행을 부모 DB 로 잘못 밀어 중복 생성·오배치를 낸다.
 * `selectStaleDbArtifacts` 와 동일한 "직속만 — 중첩 DB 보호" 규칙(`rel` 에 `/` 없음)을 적용한다.
 * 폴더 경계도 정확히 본다: `localFolder` 가 `databases/tasks` 면 형제 폴더
 * `databases/tasks2/x.md` 는 `databases/tasks/` prefix 에 걸리지 않아 자연히 제외된다.
 *
 * 입력은 이미 마크다운으로 필터된 목록을 가정한다(확장자 재검증 안 함). 결정적: 입력 순서
 * 보존, 부수효과 없음.
 *
 * @param files       볼트의 마크다운 파일 참조 목록(경로 기준)
 * @param localFolder DB 폴더 경로(확장자·후행 슬래시 무관)
 */
export function selectDbRowFiles<T extends VaultPathRef>(
  files: ReadonlyArray<T>,
  localFolder: string,
): T[] {
  const prefix = localFolder.endsWith("/") ? localFolder : `${localFolder}/`;
  return files.filter((file) => {
    if (!file.path.startsWith(prefix)) return false;
    const rel = file.path.slice(prefix.length);
    return rel.length > 0 && !rel.includes("/");
  });
}

/**
 * 동명 충돌을 풀 때 시도할 경로 후보를 **결정적 순서**로 만든다.
 *
 * 자연 이름 → 페이지 ID 조각 8 → 16 → 32 글자 순. 순번(`(1)`, `(2)` …)이 아니라 ID 를
 * 쓰는 이유는 **안정성**이다. 순번은 그때그때 볼트에 무엇이 있느냐로 결정되므로 두 페이지가
 * 실행마다 접미사를 맞바꿀 수 있고, 그러면 pull 마다 파일이 뒤바뀌어 churn 이 끝나지 않는다.
 * 페이지 ID 는 불변이라 어떤 순서로 처리되든 같은 페이지가 항상 같은 경로로 수렴한다.
 *
 * 마지막 후보(전체 32 글자)는 전역 유일하므로 후보가 고갈되는 일은 없다 — 호출부는
 * "고갈 시 원본 덮어쓰기" 같은 폴백을 두지 않아도 된다.
 *
 * @param dir      상위 폴더 경로(빈 문자열이면 볼트 루트)
 * @param safeName sanitize 된 파일명(확장자 제외)
 * @param pageId   대상 Notion 페이지 ID (하이픈 유무 무관)
 */
export function pagePathCandidates(dir: string, safeName: string, pageId: string): string[] {
  const base = dir ? `${dir}/${safeName}` : safeName;
  const raw = pageId.replace(/-/g, "");
  return [`${base}.md`, ...[8, 16, 32].map((len) => `${base} (${raw.slice(0, len)}).md`)];
}

/**
 * DB 행 파일 경로를 충돌 없이 결정한다.
 *
 * 같은 DB 에 동명 페이지(예: 제목이 비어 "제목 없음" 으로 수렴하는 행들)가 여럿
 * 있으면 Notion 페이지 ID 조각으로 디스앰비규에이션한다. 단 ID 앞 8 글자는 같은
 * DB 안에서 **유일하지 않다** — 노션 페이지 ID 는 생성 시각 기반이라 앞자리가
 * 비랜덤이어서, 같은 DB 의 두 동명 페이지가 같은 8 글자 prefix 를 갖는 일이 흔하다.
 * 단일 8 글자 접미사만 쓰면 두 페이지가 **동일 경로**로 귀결되어
 *   ① 한 페이지가 다른 페이지의 파일을 덮어써 데이터가 유실되고
 *   ② 매 pull 마다 두 페이지가 같은 파일을 두고 핑퐁하여 멱등성(churn 0)이 깨진다.
 *
 * 따라서 후보 경로가 *다른* 페이지에 이미 점유되어 있으면 ID 조각을 8→16→32 로
 * 넓혀 유일 경로를 찾는다. 두 페이지의 ID 는 불변이므로 항상 같은 경로로 수렴 →
 * 한 번 배정된 뒤에는 sync_state 에 경로가 고정되어(다음 pull 은 기존 레코드 경로
 * 재사용) churn 이 발생하지 않는다.
 *
 * @param localFolder DB 폴더 경로 (확장자·슬래시 없는 디렉터리)
 * @param safeName    sanitize 된 파일명(확장자 제외)
 * @param pageId      대상 Notion 페이지 ID (하이픈 유무 무관)
 * @param lookupByPath 후보 경로의 현재 소유 레코드를 돌려주는 조회 함수(없으면 null)
 */
export function resolveDbRowPath(
  localFolder: string,
  safeName: string,
  pageId: string,
  lookupByPath: (path: string) => PathOwner | null,
): string {
  const ownedBySelf = (candidate: string): boolean => {
    const owner = lookupByPath(candidate);
    // 점유자가 없으면 비어 있는 경로 → 사용 가능.
    // 점유자의 ID 가 비어 있으면(레코드 손상 등) 자기 소유로 단정하지 않고 회피한다.
    if (!owner) return true;
    return owner.notionPageId != null && notionIdsEqual(owner.notionPageId, pageId);
  };

  const candidates = pagePathCandidates(localFolder, safeName, pageId);
  // 전체 ID(32 글자) 후보는 전역 유일하므로 find 는 실질적으로 항상 성공한다.
  // 도달 불가 경로이나 방어적으로 마지막(가장 유일한) 후보를 돌려준다.
  return candidates.find(ownedBySelf) ?? candidates[candidates.length - 1]!;
}
