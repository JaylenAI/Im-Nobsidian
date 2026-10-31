import { INITIAL_MIGRATION } from "./001-initial.js";
import { FILE_REGISTRY_MIGRATION } from "./002-file-registry.js";
import { STAT_CACHE_MIGRATION } from "./003-stat-cache.js";
import { REMOTE_OBSERVATION_MIGRATION } from "./004-remote-observation.js";
import { PATH_NOCASE_MIGRATION } from "./005-path-nocase.js";
import { WIKILINK_NOCASE_MIGRATION } from "./006-wikilink-nocase.js";

/** 스키마 하나 — 이 버전보다 낮은 DB 에 `sql` 을 돌린다. `sql` 은 끝에 `schema_version` 을 올린다. */
export interface StateDbMigration {
  readonly version: number;
  readonly sql: string;
}

/**
 * 상태 DB 스키마 — 차례대로. CLI(better-sqlite3)와 플러그인(sql.js)이 이 목록 하나를 돈다. 예전에는 플러그인이
 * SQL 을 손으로 베껴, 처음 두 스키마의 CHECK 제약이 플러그인 DB 에만 없었다.
 */
export const STATE_DB_MIGRATIONS: readonly StateDbMigration[] = [
  { version: 1, sql: INITIAL_MIGRATION },
  { version: 2, sql: FILE_REGISTRY_MIGRATION },
  { version: 3, sql: STAT_CACHE_MIGRATION },
  { version: 4, sql: REMOTE_OBSERVATION_MIGRATION },
  { version: 5, sql: PATH_NOCASE_MIGRATION },
  { version: 6, sql: WIKILINK_NOCASE_MIGRATION },
];
