import type { Config } from "../types/config.js";
import type { SyncRecord } from "../types/sync.js";

/** DB 모드 — 볼트의 노트가 설정한 한 DB 의 행이다. 아니면 부모 페이지 아래의 페이지 트리다. */
export function isDatabaseMode(config: Config): boolean {
  return config.notion.parentMode === "database" && !!config.notion.databaseId;
}

/**
 * 이 레코드가 DB 행이면 그 DB id, 페이지면 null.
 *
 * 행인지는 전역 모드가 아니라 **레코드** 가 정한다. 페이지 모드 볼트에도 자동 발견된 DB 의
 * 행(`db-row`)이 있다 — 전역 모드로 가르면 그 행이 페이지로 밀려 속성은 제목만 가고
 * 나머지는 본문 첫머리에 YAML 로 끼워진다(S-01 · S-02).
 */
export function rowDatabaseOf(config: Config, record: SyncRecord): string | null {
  if (record.fileType === "db-row") {
    if (!record.notionParentId) {
      // 행을 페이지처럼 밀면 속성이 본문으로 새므로, 어느 DB 의 행인지 모르면 멈춘다.
      throw new Error(`DB 행인데 소속 DB 를 알 수 없음: ${record.obsidianPath}`);
    }
    return record.notionParentId;
  }
  if (isDatabaseMode(config)) return config.notion.databaseId!;
  return null;
}
