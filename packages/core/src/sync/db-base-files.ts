import type { IStateDB } from "../state/state-db-interface.js";
import type { BaseViewRecord } from "./base-view-record.js";
import { compactNotionId } from "../utils/id.js";

/** DB 마다 실제로 기록한 `.base` 를 두는 상태 메타 키. */
export const DB_BASE_FILES_META_KEY = "db_base_files";

export interface DbBaseFile {
  readonly basePath: string;
  readonly title: string;
  /**
   * pull 이 그 경로에 마지막으로 쓴 내용의 해시 — 파일이 이것과 다르면 볼트에서 고친 것이라 덮어쓰지 않는다. 예전 버전이
   * 적은 기록에는 없다 — 그때는 가를 수 없어 예전처럼 쓰고, 쓴 해시부터 적는다.
   */
  readonly hash?: string;
  /**
   * pull 이 쓴 보기들 — 볼트에서 고친 보기를 push 가 Notion 보기에 올릴 때 견준다(ADR-046). pull 이 이 경로에 쓴
   * 파일에만 있다(직접 만든 `.base` 에는 없다).
   */
  readonly views?: readonly BaseViewRecord[];
  /** 올리지 않는 나머지의 지문(`restSignature`) — 같아야 고친 것을 모두 올린 것이다. */
  readonly rest?: string;
  /**
   * 보기 말고의 키의 지문(`docRestOf`) — 보기를 더하거나 지운 `.base` 는 {@link rest} 로 견줄 수 없어 보기마다의
   * 지문(`BaseViewRecord.rest`)과 이것으로 견준다. 예전 기록에는 없다.
   */
  readonly docRest?: string;
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
  /** 마지막으로 읽거나 쓴 메타 값 — 그 사이 다른 쪽(폴더를 옮긴 NoteRelocator)이 고쳐 적었으면 다시 읽는다. */
  private loadedRaw: string | null = null;

  constructor(private readonly stateDb: Pick<IStateDB, "getMeta" | "setMeta">) {}

  get(databaseId: string): DbBaseFile | undefined {
    return this.load().get(compactNotionId(databaseId));
  }

  /** 기록한 DB 모두 — 키는 줄인 DB id. */
  all(): Array<[string, DbBaseFile]> {
    return [...this.load().entries()];
  }

  set(databaseId: string, info: DbBaseFile): void {
    const entries = this.load();
    const key = compactNotionId(databaseId);
    const known = entries.get(key);
    const next = normalize(info);
    if (known && JSON.stringify(known) === JSON.stringify(next)) return;
    entries.set(key, next);
    this.loadedRaw = JSON.stringify(Object.fromEntries(entries));
    this.stateDb.setMeta(DB_BASE_FILES_META_KEY, this.loadedRaw);
  }

  /** 상태 메타에서 읽는다 — 값이 그대로면 읽어 둔 것을 쓴다. 없거나 깨졌으면 비어 있다 — 이번 실행이 기록하는 것부터 다시 쌓는다. */
  private load(): Map<string, DbBaseFile> {
    const raw = this.stateDb.getMeta(DB_BASE_FILES_META_KEY);
    // 비어 있으면 읽어 둔 것을 쓴다 — 지우는 쪽은 없고, 적은 값을 돌려주지 않는 저장소(시험 모의)도 있다.
    if (this.entries && (raw === null || raw === this.loadedRaw)) return this.entries;
    this.entries = new Map();
    this.loadedRaw = raw;
    if (!raw) return this.entries;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return this.entries;
      for (const [key, value] of Object.entries(parsed)) {
        const entry = value as Partial<DbBaseFile> | null;
        if (typeof entry?.basePath === "string" && typeof entry.title === "string") {
          this.entries.set(
            compactNotionId(key),
            normalize({
              basePath: entry.basePath,
              title: entry.title,
              ...(typeof entry.hash === "string" ? { hash: entry.hash } : {}),
              ...(Array.isArray(entry.views) ? { views: entry.views } : {}),
              ...(typeof entry.rest === "string" ? { rest: entry.rest } : {}),
              ...(typeof entry.docRest === "string" ? { docRest: entry.docRest } : {}),
            }),
          );
        }
      }
    } catch {
      // 깨진 값 — 빈 채로 둔다.
    }
    return this.entries;
  }
}

/** 키 차례를 고정한 기록 — 같은 값이면 같은 글자라 바뀐 것만 쓴다. */
function normalize(info: DbBaseFile): DbBaseFile {
  return {
    basePath: info.basePath,
    title: info.title,
    ...(info.hash ? { hash: info.hash } : {}),
    ...(info.views && info.views.length > 0 ? { views: info.views } : {}),
    ...(info.views && info.views.length > 0 && info.rest ? { rest: info.rest } : {}),
    ...(info.views && info.views.length > 0 && info.docRest ? { docRest: info.docRest } : {}),
  };
}
