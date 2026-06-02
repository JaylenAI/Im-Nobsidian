/**
 * DB 산출물(`.base`/사이드카 `.notion.json`) rename 고아 정리 — 순수 선택 로직.
 *
 * Notion DB 제목이 바뀌면 산출물 파일명(`sanitizeFileName(title)`)이 바뀌어 옛 이름의
 * `.base`·`.notion.json` 이 **같은 폴더에 고아로 잔존**한다. 이는 pull 멱등을 깨고
 * (drift) 삭제 검증에서 부활(resurrection)로 잡히는 결함이다. 본 모듈은 어떤 파일을
 * 삭제 대상으로 고를지를 **부수효과 없이 결정**한다(테스트·재사용 용이).
 */

/** 볼트 파일 참조의 최소 형태(경로만 필요). */
export interface VaultFileRef {
  readonly path: string;
}

/** DB 폴더 직속에서 정리 대상이 되는 산출물 확장자. */
const ARTIFACT_SUFFIXES = [".base", ".notion.json"] as const;

/**
 * `localFolder` **직속**의 고아 `.base`/`.notion.json` 경로를 고른다.
 *
 * 규칙:
 * - `localFolder/` 로 시작하고 그 뒤에 `/` 가 없는 **직속 파일만** 대상 — 하위 폴더(중첩 DB)의
 *   산출물은 각자의 DB 동기화가 관리하므로 절대 건드리지 않는다.
 * - 확장자가 `.base` 또는 `.notion.json` 인 것만.
 * - `keepPaths` 에 포함된 **현재 산출물**은 제외.
 *
 * 결정적: 입력 순서를 보존해 반환(멱등·테스트 안정). 부수효과 없음.
 */
export function selectStaleDbArtifacts(
  files: ReadonlyArray<VaultFileRef>,
  localFolder: string,
  keepPaths: ReadonlySet<string>,
): string[] {
  const prefix = `${localFolder}/`;
  const stale: string[] = [];
  for (const file of files) {
    const path = file.path;
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    if (rel.includes("/")) continue; // 폴더 직속만 — 중첩 DB 산출물 보호
    if (!ARTIFACT_SUFFIXES.some((suffix) => rel.endsWith(suffix))) continue;
    if (keepPaths.has(path)) continue;
    stale.push(path);
  }
  return stale;
}
