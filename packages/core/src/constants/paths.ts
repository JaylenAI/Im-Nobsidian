/**
 * 내부 메타데이터 경로 단일 진실원(SSOT).
 *
 * `.im-nobsidian` 디렉터리·하위 파일명·ignore 파일·gitignore 항목을 한곳에서 정의한다.
 * 디렉터리/파일명을 바꾸거나 리브랜딩할 때 이 파일만 수정하면 전 패키지에 반영된다.
 */

/** 내부 메타데이터 디렉터리명 (vault 루트 기준). */
export const INTERNAL_DIR = ".im-nobsidian";

/** 동기화 설정 파일명. */
export const CONFIG_FILE = "config.json";

/** SQLite 상태 DB 파일명. */
export const STATE_DB_FILE = "sync.db";

/** DB 뷰 메타데이터 파일명. */
export const DB_VIEWS_FILE = "db-views.json";

/** 동기화 제외 패턴 파일명 (디렉터리 외부, vault 루트 직속). */
export const IGNORE_FILE = ".im-nobsidian-ignore";

/** `.gitignore`에 추가하는 항목. */
export const GITIGNORE_ENTRY = `${INTERNAL_DIR}/`;

/** vault 상대 POSIX 경로 — DB 뷰 메타데이터. */
export const DB_VIEWS_PATH = `${INTERNAL_DIR}/${DB_VIEWS_FILE}`;

/** vault 상대 POSIX 경로 — 상태 DB. */
export const STATE_DB_PATH = `${INTERNAL_DIR}/${STATE_DB_FILE}`;

/** 파일 감시에서 제외할 내부 디렉터리 glob. */
export const INTERNAL_DIR_GLOB = `**/${INTERNAL_DIR}/**`;

/**
 * 주어진 vault 상대 경로(POSIX)가 내부 메타데이터 디렉터리에 속하는지 판별한다.
 */
export function isInternalPath(path: string): boolean {
  return path === INTERNAL_DIR || path.startsWith(`${INTERNAL_DIR}/`);
}
