import type { IStateDB } from "../state/state-db-interface.js";
import type { SidecarProperty } from "../view/sidecar-generator.js";
import { compactNotionId } from "../utils/id.js";

/** DB 마다 pull 이 마지막으로 쓴 사이드카를 두는 상태 메타 키. */
export const SIDECAR_BASES_META_KEY = "sidecar_bases";

/**
 * pull 이 마지막으로 쓴 사이드카(`<db>.notion.json`) — 볼트에서 고쳤는지 가르고(해시), 고친 속성을 무엇과 견줄지(속성)
 * 안다(ADR-045). 기록이 없는 사이드카(예전 버전이 쓴 것 · 다른 볼트에서 가져온 것)는 고친 것으로 보지 않는다.
 */
export interface SidecarBase {
  readonly path: string;
  readonly hash: string;
  readonly properties: readonly SidecarProperty[];
}

export class SidecarBases {
  constructor(private readonly stateDb: Pick<IStateDB, "getMeta" | "setMeta">) {}

  get(databaseId: string): SidecarBase | undefined {
    return this.load()[compactNotionId(databaseId)];
  }

  set(databaseId: string, base: SidecarBase): void {
    const all = this.load();
    const key = compactNotionId(databaseId);
    if (JSON.stringify(all[key]) === JSON.stringify(base)) return;
    all[key] = base;
    this.stateDb.setMeta(SIDECAR_BASES_META_KEY, JSON.stringify(all));
  }

  /** 기록한 DB 마다 — 하이픈 없는 id 와 그 기록. */
  entries(): Array<readonly [string, SidecarBase]> {
    return Object.entries(this.load());
  }

  private load(): Record<string, SidecarBase> {
    const raw = this.stateDb.getMeta(SIDECAR_BASES_META_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, SidecarBase> = {};
      for (const [key, value] of Object.entries(parsed)) {
        const entry = value as Partial<SidecarBase> | null;
        if (
          typeof entry?.path === "string" &&
          typeof entry.hash === "string" &&
          Array.isArray(entry.properties)
        ) {
          out[key] = { path: entry.path, hash: entry.hash, properties: entry.properties };
        }
      }
      return out;
    } catch {
      return {};
    }
  }
}
