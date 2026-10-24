/**
 * DB 산출물(`.base`/사이드카 `.notion.json`) rename 고아 정리 — 순수 선택 로직.
 *
 * Notion DB 제목이 바뀌면 산출물 파일명(`sanitizeFileName(title)`)이 바뀌어 옛 이름의
 * `.base`·`.notion.json` 이 **같은 폴더에 고아로 잔존**한다. 이는 pull 멱등을 깨고
 * (drift) 삭제 검증에서 부활(resurrection)로 잡히는 결함이다. 본 모듈은 어떤 파일을
 * 삭제 대상으로 고를지를 **부수효과 없이 결정**한다(테스트·재사용 용이).
 */

import { BASE_SUFFIX, SIDECAR_SUFFIX } from "../constants/paths.js";
import { BASE_FILE_HEADER } from "../view/base-file-generator.js";
import { SIDECAR_GENERATOR } from "../view/sidecar-generator.js";

/** 볼트 파일 참조의 최소 형태(경로만 필요). */
export interface VaultFileRef {
  readonly path: string;
}

/** DB 폴더 직속에서 정리 대상이 되는 산출물 확장자. */
const ARTIFACT_SUFFIXES = [BASE_SUFFIX, SIDECAR_SUFFIX] as const;

/**
 * 동기화 도구 자신이 만드는 내부 산출물(`.base` 뷰 / `.notion.json` 사이드카) 여부.
 * 첨부파일 push(FileHandler)는 이 파일들을 Notion 에 업로드하면 안 되고, 고아 정리
 * (cleanupStaleDbArtifacts)는 반대로 이 파일들만 다뤄야 한다 — 판정을 한곳에 둔다.
 */
export function isDbArtifactPath(path: string): boolean {
  return ARTIFACT_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * pull 이 쓴 산출물인가 — `.base` 는 생성 머리({@link BASE_FILE_HEADER})로, 사이드카는 `generator` 로 가린다.
 * 사용자가 DB 폴더에 직접 만든 Bases 파일은 아니다 — 예전 pull 은 그것을 고아로 보고 지우거나 같은 이름이면
 * 덮어썼다.
 */
export function isGeneratedDbArtifact(path: string, content: string): boolean {
  if (path.endsWith(BASE_SUFFIX)) return content.startsWith(BASE_FILE_HEADER);
  if (!path.endsWith(SIDECAR_SUFFIX)) return false;
  try {
    return (JSON.parse(content) as { generator?: unknown }).generator === SIDECAR_GENERATOR;
  } catch {
    return false;
  }
}

/**
 * `localFolder` **직속**의 고아 `.base`/`.notion.json` 경로를 고른다. 지우기 전에
 * {@link isGeneratedDbArtifact} 로 pull 이 쓴 것인지 한 번 더 본다 — 여기서는 내용을 읽지 않는다.
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
