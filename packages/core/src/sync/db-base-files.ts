import type { IStateDB } from "../state/state-db-interface.js";
import { compactNotionId } from "../utils/id.js";

/** DB 마다 실제로 기록한 `.base` 를 두는 상태 메타 키. */
export const DB_BASE_FILES_META_KEY = "db_base_files";

export interface DbBaseFile {
  readonly basePath: string;
  readonly title: string;
}

/**
 * DB 마다 실제로 기록한 `.base` 경로와 DB 제목 — 인라인 DB placeholder 를 `.base` 임베드로 바꿀 때
 * 쓴다(F22). 폴더명(하이픈 새니타이즈)과 `.base` 파일명(sanitizeFileName: 공백 · 점 보존)은 규칙이
 * 달라, 폴더로 추측한 경로는 깨진 임베드가 된다(E2E 실측 91/158건).
 *
 * 예전에는 이번 실행이 기록한 것만 메모리에 두었다 — pull 마다 모든 DB 의 `.base` 를 다시 썼기
 * 때문이다. 이제는 바뀐 DB 만 조회하므로(ADR-027) 이번에 조회하지 않은 DB 의 것도 알아야 한다. 그래서
 * 상태 DB 에 남긴다. 값이 바뀔 때만 쓴다 — 전체 대조는 DB 마다 한 번씩 부른다.
 */
export class DbBaseFiles {
  private entries: Map<string, DbBaseFile> | null = null;

  constructor(private readonly stateDb: Pick<IStateDB, "getMeta" | "setMeta">) {}

  get(databaseId: string): DbBaseFile | undefined {
    return this.load().get(compactNotionId(databaseId));
  }

  set(databaseId: string, info: DbBaseFile): void {
    const entries = this.load();
    const key = compactNotionId(databaseId);
    const known = entries.get(key);
    if (known?.basePath === info.basePath && known.title === info.title) return;
    entries.set(key, { basePath: info.basePath, title: info.title });
    this.stateDb.setMeta(DB_BASE_FILES_META_KEY, JSON.stringify(Object.fromEntries(entries)));
  }

  /** 상태 메타에서 한 번 읽는다. 없거나 깨졌으면 비어 있다 — 이번 실행이 기록하는 것부터 다시 쌓는다. */
  private load(): Map<string, DbBaseFile> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    const raw = this.stateDb.getMeta(DB_BASE_FILES_META_KEY);
    if (!raw) return this.entries;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return this.entries;
      for (const [key, value] of Object.entries(parsed)) {
        const entry = value as Partial<DbBaseFile> | null;
        if (typeof entry?.basePath === "string" && typeof entry.title === "string") {
          this.entries.set(compactNotionId(key), { basePath: entry.basePath, title: entry.title });
        }
      }
    } catch {
      // 깨진 값 — 빈 채로 둔다.
    }
    return this.entries;
  }
}
