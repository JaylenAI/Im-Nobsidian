import type { IStateDB } from "../state/state-db-interface.js";
import type { SyncRecord } from "../types/sync.js";
import type { RemotePageStamp } from "./remote-observation.js";

/**
 * 갱신 WAL (P7) — 노트를 Notion 에 다시 쓰는 동안 끊겼는지 다음 실행이 알게 한다.
 *
 * 갱신은 본문 쓰기 → 코드 자리표시 채우기 · 첨부 → 속성 → 상태 DB 순이다. 본문을 쓴 뒤 응답을 잃거나 프로세스가
 * 죽으면 원격에는 이 도구가 쓴 글이 있는데 상태 DB 는 지난번 그대로다. 지난번 편집자가 사람이면 수정 시각 · 편집자로
 * 가를 수 없어(봇 규칙은 «지난번에도 이 봇» 일 때만) 다음 push 는 pull 을 먼저 하라 했고, 그 pull 은 이 도구가 쓴
 * 글을 로컬 편집과 부딪는 충돌로 올렸다(ADR-029 의 알려진 한계).
 *
 * 본문을 보내기 전에 보내는 노트의 해시를 적고, 상태 DB 에 적으면 마친다. 다음 실행은 끊긴 기록이 있고 · 노트가
 * 그때 보내던 글 그대로이며 · 원격을 마지막으로 고친 것이 이 봇이면 원격을 «이 도구가 쓰다 만 것» 으로 본다 —
 * push 는 마저 올리고, pull 은 받을 것이 없다고 본다. 그 뒤 사람이 고쳤으면 마지막 편집자가 사람이라 예전 규칙대로
 * 가른다.
 */
export class UpdateJournal {
  constructor(private readonly stateDb: IStateDB) {}

  /**
   * 보내기 전에 적는다. 같은 노트의 끊긴 기록은 마친 것으로 돌린다 — 이번에 보내는 글이 그것을 대신한다.
   * @param sentHash 보내는 노트 글의 해시(`computeHash(content)`).
   */
  begin(recordId: string, sentHash: string): void {
    this.finish(recordId);
    this.stateDb.recordPendingOperation({
      syncStateId: recordId,
      operation: "update",
      direction: "push",
      payload: JSON.stringify({ hash: sentHash }),
    });
  }

  /** 상태 DB 에 적었다 — 끊긴 기록을 마친다. */
  finish(recordId: string): void {
    for (const op of this.stateDb.getIncompletePendingOperations()) {
      if (op.syncStateId === recordId && op.operation === "update") {
        this.stateDb.markPendingCompleted(op.id);
      }
    }
  }

  /**
   * 원격이 이 노트를 쓰다 끊긴 그대로인가.
   * @param localHash 지금 노트 글의 해시 — 그때 보내던 글과 같아야 한다. 그 뒤 고쳤으면 끊긴 쓰기로 보지 않는다.
   * @param botUserId 이 토큰의 봇 id. 모르면 가를 수 없어 아니다.
   */
  wroteRemote(
    record: SyncRecord,
    remote: RemotePageStamp,
    localHash: string,
    botUserId: string | null,
  ): boolean {
    if (botUserId === null || remote.last_edited_by?.id !== botUserId) return false;
    const op = this.stateDb.getIncompleteOpByState(record.id, "update");
    if (!op?.payload) return false;
    try {
      return (JSON.parse(op.payload) as { hash?: unknown }).hash === localHash;
    } catch {
      return false;
    }
  }
}
