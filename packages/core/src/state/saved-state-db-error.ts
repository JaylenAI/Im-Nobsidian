import { STATE_DB_PATH } from "../constants/paths.js";

/**
 * 저장된 상태 DB 파일로 DB 를 열지 못했다 — 비었거나 잘렸거나 상태 DB 가 아닌 파일이다. 두 구현(CLI 의
 * better-sqlite3 · 플러그인의 sql.js)이 같이 던진다. 엔진을 띄우지 못한 것 같은 다른 실패와 가른다 — 파일을
 * 치우라는 안내({@link damagedStateDbGuidance})는 이 경우에만 맞다.
 */
export class SavedStateDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedStateDbError";
  }

  /**
   * 동기화 기록 표가 없다 — SQLite 는 비었거나(0바이트) 앞 한 바이트만 남은 파일을 «빈 DB» 로 연다. 보지 않으면
   * 기록을 잃은 채 처음부터 시작하고, 다음 push 가 모든 노트의 페이지를 또 만든다.
   */
  static noTables(bytes: number): SavedStateDbError {
    return new SavedStateDbError(`저장된 상태 DB 파일에 동기화 기록이 없음 (${bytes}바이트)`);
  }

  /** SQLite 가 파일을 열지 못했다 — 잘렸거나(malformed) 상태 DB 가 아니다(not a database). */
  static unreadable(error: unknown): SavedStateDbError {
    const reason = error instanceof Error ? error.message : String(error);
    return new SavedStateDbError(`저장된 상태 DB 파일을 열지 못함 (${reason})`);
  }
}

/**
 * 저장된 파일에 동기화 기록 표가 있는지 묻는 조회 — 한 번이라도 쓴 파일에는 마이그레이션이 만든 표가 있다. 한
 * 페이지 이상 잘린 파일은 SQLite 가 이 조회에서 던진다(malformed).
 */
export const SAVED_STATE_TABLES_QUERY =
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_metadata'";

/**
 * 저장된 상태 DB 파일이 깨졌을 때 할 일 — 화면마다 다시 해 보는 법(`retry`)만 다르다. 폴더 이름이 점으로 시작해
 * Obsidian 의 파일 탐색기에는 보이지 않으므로 볼트 폴더에서 찾으라고 적는다.
 */
export function damagedStateDbGuidance(retry: string): string {
  return (
    `볼트 폴더의 ${STATE_DB_PATH} 를 사본으로 바꾸거나 다른 곳으로 옮긴 뒤 ${retry}. ` +
    "옮기면 처음부터 시작합니다 — 노트와 Notion 페이지의 짝을 잃어 다음 push 가 페이지를 새로 만듭니다."
  );
}
