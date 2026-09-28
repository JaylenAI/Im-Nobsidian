import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type { SyncRecord } from "../types/sync.js";
import { computeHash } from "../utils/hash.js";
import { inAnyPathScope } from "../utils/path-scope.js";
import { isFolderRecord } from "./folder-container.js";
import type { VaultFS } from "./vault-fs.js";

/**
 * 추적 중(sync_state)인데 디스크에서 사라진 파일을 찾는다.
 *
 * 원격 변경 감지(detectRemoteChanges*)는 "Notion 에서 바뀐 것"만 본다. 로컬에서 파일이
 * 지워진 경우는 어느 경로로도 잡히지 않아, 재pull 해도 `--force` 로도 되살아나지 않고
 * 영구히 발산했다. push 는 deleteSync=false 면 원격을 지우지 않으므로 사용자에겐 복구
 * 수단이 볼트 전체 초기화밖에 남지 않는다 — 이 스캔이 그 마지막 구멍을 막는다.
 *
 * 레코드마다 stat 을 던지면 1000건 규모에서 수 초가 든다. 볼트 워크 1회로 실재 목록을
 * 만든 뒤 차집합을 취한다(md). md 가 아닌 추적 레코드는 수가 적어 개별 확인으로 남긴다.
 *
 * 로컬 이름변경·이동은 "사라짐" 과 구별해야 한다 — 되살리면 원본과 새 이름의 사본이
 * 둘 다 남는다. push 의 detectMoves 와 같은 기준(내용 해시 일치)을 쓰되, 볼트 전체를
 * 해시하지 않도록 크기가 같은 미추적 파일만 후보로 좁혀 확인한다.
 */
export async function detectMissingLocalFiles(
  config: Config,
  stateDb: IStateDB,
  vaultFs: VaultFS,
  paths?: string[],
): Promise<SyncRecord[]> {
  // deleteSync 가 켜져 있으면 로컬 삭제는 "원격에도 지우라" 는 의사 표시다. sync() 는
  // pull 을 먼저 돌리므로 여기서 되살리면 뒤이은 push 가 지울 대상을 잃어 삭제 의도가
  // 통째로 무효화된다. 복원은 삭제를 전파할 수단이 아예 없는 설정(deleteSync=false)
  // 에서만 유일하게 옳은 해석이다.
  if (config.sync.deleteSync) return [];

  const records = stateDb.getAll();
  if (records.length === 0) return [];

  const scoped = records.filter(
    (r) =>
      // folder-only 는 실체가 폴더라 파일 부재가 정상. db-row 를 제외하는 이유는
      // 여기서 되살리면 행 전용 frontmatter(속성 매핑) 없이 본문만 쓰는 잘못된 경로로
      // 새기 때문이다 — 복원은 반드시 database-syncer 의 행 경로가 해야 한다.
      // 다만 그쪽이 실제로 복원하는지는 오래 참이 아니었다: 원격 무변경이면 로컬 존재를
      // 묻지도 않고 건너뛰어, 지운 행이 어느 경로로도 돌아오지 않았다. R13 에서 그
      // 존재 확인을 넣어 이 제외가 비로소 근거를 갖는다(tests/sync/db-row-restore-deleted).
      // push 가 만든 폴더 페이지(폴더 레코드)도 실체가 폴더다 — 안의 노트를 되살리면 폴더도
      // 생긴다. 예전에는 폴더 경로에 확장자 없는 파일을 썼다(S-17).
      (r.fileType === "file" || r.fileType === "folder-note") &&
      !isFolderRecord(r) &&
      r.notionPageId !== null &&
      inAnyPathScope(r.obsidianPath, paths),
  );
  if (scoped.length === 0) return [];

  const stats = await vaultFs.listMarkdownFileStats();
  const live = new Set(stats.map((f) => f.path));

  const candidates: SyncRecord[] = [];
  for (const record of scoped) {
    if (record.obsidianPath.endsWith(".md")) {
      if (!live.has(record.obsidianPath)) candidates.push(record);
    } else if (!(await vaultFs.exists(record.obsidianPath))) {
      candidates.push(record);
    }
  }
  if (candidates.length === 0) return [];

  // 이름이 바뀐 파일은 추적 경로에 없다 — 미추적 실재 파일만 크기별로 색인한다.
  const tracked = new Set(records.map((r) => r.obsidianPath));
  const untrackedBySize = new Map<number, string[]>();
  for (const f of stats) {
    if (tracked.has(f.path)) continue;
    const bucket = untrackedBySize.get(f.size);
    if (bucket) bucket.push(f.path);
    else untrackedBySize.set(f.size, [f.path]);
  }

  const hashCache = new Map<string, string | null>();
  const hashOf = async (path: string): Promise<string | null> => {
    const cached = hashCache.get(path);
    if (cached !== undefined) return cached;
    let hash: string | null = null;
    try {
      hash = computeHash(await vaultFs.readFile(path));
    } catch {
      // 못 읽는 파일은 이름변경 판정에서 제외 — 확신 없이 복원을 취소하지 않는다.
    }
    hashCache.set(path, hash);
    return hash;
  };

  const missing: SyncRecord[] = [];
  for (const record of candidates) {
    // localFileSize 는 크기 버킷으로 후보를 좁히는 최적화일 뿐이다. 구버전이 남긴
    // 레코드처럼 값이 없으면 버킷을 못 고르는데, 여기서 빈 배열로 끝내면 이름변경을
    // 놓쳐 원본 이름 사본이 되살아난다. 미추적 마크다운은 정상 볼트에서 거의 0건이라
    // (실측: 추적 1189 / 볼트 md 1189) 전수 대조로 폴백해도 비용이 없다.
    const sameSize =
      record.localFileSize !== null
        ? (untrackedBySize.get(record.localFileSize) ?? [])
        : [...untrackedBySize.values()].flat();
    let renamed = false;
    for (const path of sameSize) {
      if ((await hashOf(path)) === record.contentHash) {
        renamed = true;
        break;
      }
    }
    if (!renamed) missing.push(record);
  }
  return missing;
}
