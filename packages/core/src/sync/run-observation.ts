import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { RemoteChange, SyncRecord } from "../types/sync.js";
import { getLogger } from "../utils/logger.js";
import {
  compareRemote,
  NO_OBSERVATION,
  observationOf,
  observedRecordFields,
  type ObservationContext,
  type ObservedRecordFields,
  type RemotePageStamp,
  type RemoteVerdict,
} from "./remote-observation.js";

/**
 * 이번 실행이 원격을 보는 기준(N-05) — push · pull · status 가 시작할 때 정하고, 원격 판정과 관측
 * 기록이 같은 값을 쓴다. 가르는 규칙은 {@link compareRemote} 가 정한다 — 여기는 실행마다 바뀌는
 * 기준(본 시각 · 봇 id)을 들고, 본 것을 상태 DB 에 적는다.
 *
 * 작업은 한 번에 하나만 돈다(S-09) — 두 실행이 이 기준을 함께 쓰지 않는다.
 */
export class RunObservation {
  private current: ObservationContext = NO_OBSERVATION;

  constructor(
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
  ) {}

  /** 지금 기준 — DB 행을 받는 쪽(DatabaseSyncer)도 같은 기준으로 가른다. */
  get context(): ObservationContext {
    return this.current;
  }

  /**
   * 이번 실행이 원격을 보는 기준을 정한다(N-05). 본 시각은 실행을 시작한 시각이다 — 이 실행이
   * 받는 원격은 모두 그 뒤에 본 것이라, 가라앉았다고 서둘러 보지 않는다. 봇 id 는
   * {@link resolveBotUserId} 가 따로 받는다 — 할 일이 없는 실행은 묻지 않는다.
   */
  begin(startTime: number): void {
    this.current = { seenAt: new Date(startTime).toISOString(), botUserId: null };
  }

  /** 이 토큰의 봇 id 를 받아 둔다. 받지 못하면 봇 규칙 없이 간다 — 내용으로 한 번 더 확인할 뿐이다. */
  async resolveBotUserId(): Promise<void> {
    if (this.current.botUserId !== null) return;
    try {
      const botUserId = await this.notionClient.getBotUserId();
      this.current = { ...this.current, botUserId };
    } catch (error) {
      getLogger().warn(
        `[Im-Nobsidian] 이 통합의 봇 id 를 받지 못함 — 방금 쓴 페이지도 내용으로 다시 확인한다: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 레코드가 지난번에 본 원격과 지금 원격을 견준다 — 이번 실행의 기준으로. */
  verdict(record: SyncRecord, page: RemotePageStamp): RemoteVerdict {
    return compareRemote(record, page, this.current.botUserId);
  }

  /** 추적 중인 페이지의 원격 변경 — 바뀌지 않았으면 null. 가를 수 없으면 «확인 안 됨» 으로 싣는다. */
  modification(
    record: SyncRecord,
    page: RemotePageStamp & { readonly id: string },
  ): RemoteChange | null {
    const verdict = this.verdict(record, page);
    if (verdict === "unchanged") return null;
    return {
      pageId: page.id,
      type: "modified",
      path: record.obsidianPath,
      lastEdited: page.last_edited_time,
      previousEdited: record.notionLastEdited,
      ...(verdict === "unverified" ? { unverified: true } : {}),
    };
  }

  /** 지금 본 원격 페이지를 레코드에 적을 값 — {@link observedRecordFields} 를 이번 실행의 기준으로. */
  fieldsOf(page: RemotePageStamp, bodyFingerprint: string | null): ObservedRecordFields {
    return observedRecordFields(page, this.current.seenAt, bodyFingerprint);
  }

  /**
   * 원격을 언제 · 누가 고쳤는지 모르는 채 수정 시각만 적는다 — 다음 pull 이 내용으로 확인한다.
   * 충돌 해소처럼 원격 본문을 언제 받았는지 모르는 자리에서 쓴다. 본문 지문도 모른다 — 그 전에
   * push 하면 원격이 바뀌었는지 확인하지 못해 pull 을 먼저 하라며 거절한다.
   */
  recordUnverified(recordId: string, lastEdited: string): void {
    this.stateDb.setRemoteObservation(recordId, {
      lastEdited,
      lastEditedBy: null,
      seenAt: null,
      bodyFingerprint: null,
    });
  }

  /**
   * 지금 본 원격 페이지를 레코드에 적는다.
   *
   * @param bodyFingerprint 본문 지문. undefined 면 적지 않는다 — 본문을 건드리지 않은 관측.
   */
  record(recordId: string, page: RemotePageStamp, bodyFingerprint?: string | null): void {
    this.stateDb.setRemoteObservation(recordId, {
      ...observationOf(page, this.current.seenAt),
      ...(bodyFingerprint === undefined ? {} : { bodyFingerprint }),
    });
  }
}
