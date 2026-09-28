import type { ConflictResolver, ResolutionChoice, ResolutionResult } from "../conflict/resolver.js";
import { choiceForStrategy, isRemoteDeletion } from "../conflict/resolver.js";
import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type {
  Conflict,
  ConflictStrategy,
  LocalChange,
  RemoteChange,
  SyncRecord,
} from "../types/sync.js";
import { computeHash } from "../utils/hash.js";
import type { ChangeDetector } from "./change-detector.js";
import type { LocalPlanner } from "./local-planner.js";
import type { PagePuller } from "./page-puller.js";
import type { PagePusher } from "./page-pusher.js";
import { remoteDeletionChange, remoteDeletionConflict, remotePresence } from "./remote-deletion.js";
import type { RunObservation } from "./run-observation.js";
import type { VaultFS } from "./vault-fs.js";

/**
 * 충돌 해소 (I8) — 해소 결과를 로컬에만 쓰지 않고 Notion 으로 재push + notionLastEdited
 * 재조정까지 한 트랜잭션으로 묶는다. ConflictResolver 단독은 로컬 write + updateHash 만
 * 수행하므로(merge 결과가 Notion 에 반영되지 않음) 다음 pull 이 원격으로 덮어써 영구
 * 유실·충돌 루프가 발생한다. 해소 → 전파(propagate)를 여기서 봉합해 무손실 보장. 변환
 * 파이프라인이 필요한 push 는 올리기 경로({@link PagePusher.pushUpdate})를 재사용한다.
 *
 * 충돌 목록도 여기서 만든다 — 상태 확인(`status`)의 미리보기와 해소할 목록이 같은 규칙을 쓴다.
 */
export class ConflictWorkflow {
  constructor(
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
    private readonly notionClient: NotionClient,
    private readonly changeDetector: ChangeDetector,
    private readonly conflictResolver: ConflictResolver,
    private readonly observation: RunObservation,
    private readonly planner: LocalPlanner,
    private readonly puller: PagePuller,
    private readonly pusher: PagePusher,
  ) {}

  /**
   * 해소 대상 충돌 목록 — 원격 본문을 pull 과 **같은 파이프라인**으로 렌더해 담는다.
   *
   * 해소는 실제로 볼트 파일을 덮어쓰므로 `status()` 의 경량 미리보기 렌더를 쓰면 안 된다
   * (프론트매터·첨부가 빠진 반쪽 본문이 덮인다). 반대로 전체 pull 을 먼저 돌려 목록을
   * 얻는 것도 안 된다 — 해소하겠다고 볼트를 먼저 원격으로 덮어쓰는 셈이라 순서가 거꾸로다.
   * 그래서 충돌 레코드만 좁혀 그 페이지들만 읽어 온다.
   */
  async listConflicts(): Promise<Conflict[]> {
    const records = this.stateDb.getByStatus("conflict");
    if (records.length === 0) return [];
    const files = await this.vaultFs.listMarkdownFiles();
    const localChanges = this.changeDetector.detectLocalChanges(
      files,
      this.planner.localScanOptions(),
    );
    return this.buildConflictsFromRecords(records, localChanges, [], { fullRender: true });
  }

  /**
   * @param options.fullRender 원격 본문을 pull 과 동일한 파이프라인으로 렌더할지.
   *   기본(false)은 화면 미리보기용 경량 렌더 — 첨부를 내려받지 않으므로 `status` 처럼
   *   읽기만 하는 경로가 쓴다. 볼트에 덮어쓸 본문이 필요한 해소 경로는 반드시 켠다.
   */
  async buildConflictsFromRecords(
    records: SyncRecord[],
    localChanges: LocalChange[],
    remoteChanges: RemoteChange[],
    options?: { fullRender?: boolean },
  ): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];

    for (const record of records) {
      const localChange = localChanges.find((c) => c.path === record.obsidianPath) ?? {
        path: record.obsidianPath,
        type: "modified" as const,
        currentHash: record.contentHash,
        previousHash: record.contentHash,
      };

      let localContent = "";
      try {
        localContent = await this.vaultFs.readFile(record.obsidianPath);
      } catch {
        // 파일이 삭제된 경우
      }

      let remoteContent = "";
      let remoteLastEdited: string | null = null;
      let remoteGone = false;
      if (record.notionPageId) {
        try {
          // 휴지통 · 보관 · 없음이면 원격에서 지운 노트의 충돌이다 — 렌더할 본문이 없다.
          const presence = await remotePresence(this.notionClient, record.notionPageId);
          if (presence.kind === "gone") {
            remoteGone = true;
          } else if (options?.fullRender) {
            remoteLastEdited = presence.page.last_edited_time;
            remoteContent = (
              await this.puller.renderRemotePage(record, record.notionPageId, presence.page)
            ).content;
          } else {
            remoteContent = (await this.puller.fetchPageMarkdown(record.notionPageId)).content;
          }
        } catch (error) {
          // 해소할 목록은 원격을 읽지 못하면 이유와 함께 실패한다(N-06). 빈 원격으로 충돌을 만들면
          // 병합은 원격이 모든 줄을 지운 것으로 보고, 원격 유지는 로컬을 빈 파일로 덮는다.
          if (options?.fullRender) {
            throw new Error(
              `충돌 노트의 원격을 읽지 못함 (${record.obsidianPath}): ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error },
            );
          }
          // 상태 표시용 미리보기 — 읽지 못하면 원격을 비워 둔 채 충돌이 있다는 것만 보인다.
        }
      }

      if (remoteGone) {
        conflicts.push(
          remoteDeletionConflict(
            record,
            localContent,
            remoteChanges.find((c) => c.pageId === record.notionPageId && c.type === "deleted") ??
              remoteDeletionChange(record),
          ),
        );
        continue;
      }

      const remoteChange = remoteChanges.find((c) => c.pageId === record.notionPageId) ?? {
        pageId: record.notionPageId ?? "",
        type: "modified" as const,
        // 현재 원격 시각을 실제로 읽어왔다면 그 값을 쓴다. 해소 후 재조정(propagateResolution)
        // 이 이 값을 그대로 기준점으로 삼는데, 낡은 저장값을 실으면 다음 pull 이 같은 변경을
        // 다시 충돌로 보고 무한 재충돌한다.
        lastEdited: remoteLastEdited ?? record.notionLastEdited ?? "",
        previousEdited: null,
      };

      conflicts.push({
        syncRecord: record,
        localChange,
        remoteChange,
        baseContent: record.baseSnapshot?.toString("utf-8") ?? null,
        localContent,
        remoteContent,
      });
    }

    return conflicts;
  }

  /**
   * 해소할 게 남지 않은 충돌 레코드를 `synced` 로 되돌리고, 되돌린 경로를 반환한다.
   *
   * 충돌로 표시된 파일은 push 대상에서 통째로 빠진다(양쪽 덮어쓰기 방지). 그래서 사용자가
   * 손으로 양쪽을 맞춰 둬 이미 같은 내용이 됐는데도 레코드만 남으면, 그 파일의 이후 편집이
   * **영원히 Notion 에 올라가지 않는다** — 아무 경고 없이 정체된다. 내용이 이미 동일한
   * 건만 골라 상태를 되돌린다(진짜 충돌은 손대지 않는다).
   */
  clearStaleConflicts(conflicts: readonly Conflict[]): string[] {
    const cleared: string[] = [];
    for (const conflict of conflicts) {
      // 양쪽 다 비었으면 "같다"가 아니라 양쪽 다 사라진 것이다 — 삭제 전파의 몫으로 남긴다.
      if (conflict.localContent === "" && conflict.remoteContent === "") continue;
      if (conflict.localContent !== conflict.remoteContent) continue;

      const record = conflict.syncRecord;
      this.stateDb.transaction(() => {
        this.stateDb.updateHash(
          record.id,
          computeHash(conflict.localContent),
          Buffer.from(conflict.localContent, "utf-8"),
        );
        this.stateDb.updateStatus(record.id, "synced");
        if (conflict.remoteChange.lastEdited) {
          this.observation.recordUnverified(record.id, conflict.remoteChange.lastEdited);
        }
      });
      cleared.push(record.obsidianPath);
    }
    return cleared;
  }

  /**
   * 충돌 하나를 고른 선택지로 해소하고 Notion 에 올린다 — 올리지 못하면 충돌로 되돌린다
   * ({@link propagateOrReopen}).
   */
  async resolveConflict(conflict: Conflict, choice: ResolutionChoice): Promise<ResolutionResult> {
    const result = await this.conflictResolver.resolve(conflict, choice);
    await this.propagateOrReopen(conflict, choice, result);
    return result;
  }

  /** 여러 충돌을 같은 전략으로 해소하고 Notion 에 올린다. */
  async resolveAllConflicts(
    conflicts: Conflict[],
    strategy: ConflictStrategy,
  ): Promise<ResolutionResult[]> {
    const results: ResolutionResult[] = [];
    // 하나를 올리지 못해도 나머지를 푼다 — 올리지 못한 것은 충돌로 되돌려져 있다(N-06).
    // 예전에는 첫 실패에서 던져, 뒤의 충돌은 손대지 않은 채 무엇이 풀렸는지도 알리지 못했다.
    for (const conflict of conflicts) {
      const choice = choiceForStrategy(conflict, strategy);
      try {
        results.push(await this.resolveConflict(conflict, choice));
      } catch (error) {
        results.push({
          path: conflict.syncRecord.obsidianPath,
          choice,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  /** 충돌 미리보기용 줄 비교(로컬 vs 원격). 해소 없이 표시 전용. */
  generateConflictDiff(conflict: Conflict): string {
    return this.conflictResolver.generateDiff(conflict);
  }

  /**
   * 해소 결과를 Notion 에 올린다. 올리지 못하면 충돌로 되돌리고 오류를 그대로 던진다(N-06).
   *
   * 해소는 지난 동기화 사본을 해소 결과로 바꿔 둔다. 그 결과가 Notion 에 없는데 «해결됨» 으로
   * 남으면, 다음 pull 은 로컬을 바뀌지 않은 것으로 보고 바뀐 원격으로 덮는다 — 고른 로컬 · 병합
   * 결과가 사라진다. 해소 전의 사본으로 되돌리면 다음 pull 이 다시 충돌로 본다. 볼트 파일(병합
   * 결과 · `.conflict` 사본)은 그대로 둔다 — 사용자가 고른 것이다.
   */
  private async propagateOrReopen(
    conflict: Conflict,
    choice: ResolutionChoice,
    result: ResolutionResult,
  ): Promise<void> {
    try {
      await this.propagateResolution(conflict, choice, result);
    } catch (error) {
      // 원격에서 지운 노트를 «로컬 유지» 로 풀면 추적을 놓은 뒤 새 페이지를 만든다 — 만들지 못해도
      // 파일은 추적하지 않는 새 노트로 남아 다음 push 가 만든다. 되돌릴 충돌이 없다.
      if (isRemoteDeletion(conflict)) {
        throw new Error(
          `Notion 에 다시 만들지 못함 — 파일은 그대로이고 다음 push 가 다시 만든다 (${
            conflict.syncRecord.obsidianPath
          }): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const record = conflict.syncRecord;
      this.stateDb.transaction(() => {
        this.stateDb.updateHash(record.id, record.contentHash, record.baseSnapshot);
        this.stateDb.updateStatus(record.id, "conflict");
      });
      throw error;
    }
  }

  /**
   * 해소 결과를 Notion 으로 전파해 로컬↔원격 일관성을 봉합한다.
   * - remote 선택: 로컬이 원격으로 갱신됐을 뿐이므로 push 불필요. notionLastEdited 만
   *   원격 변경의 lastEdited 로 재조정 → 다음 pull 이 같은 변경을 재충돌로 보지 않음.
   * - merge 실패(충돌 마커 잔존): 사용자가 직접 풀어야 하므로 conflict 상태 유지·push 안 함.
   * - local / merge(성공) / duplicate: 해소된 로컬 내용을 Notion 에 재push(pushUpdate 가
   *   변환·이미지·속성·해시·notionLastEdited 를 한 트랜잭션으로 재조정) → 무손실 수렴.
   * - 원격에서 지운 노트: local 은 새 페이지로 만들고(pushCreate), remote 는 볼트에서 지운 것으로
   *   끝난다.
   */
  private async propagateResolution(
    conflict: Conflict,
    choice: ResolutionChoice,
    result: ResolutionResult,
  ): Promise<void> {
    const record = conflict.syncRecord;
    if (!record.notionPageId) return;

    // 원격에서 지운 노트 — «원격 유지» 는 볼트에서 지운 것으로 끝났다. «로컬 유지» 는 추적을 놓은
    // 파일을 새 페이지로 만든다(지운 페이지는 휴지통에 그대로 둔다).
    if (isRemoteDeletion(conflict)) {
      if (choice === "local") await this.pusher.pushCreate(record.obsidianPath);
      return;
    }

    if (choice === "remote") {
      this.observation.recordUnverified(record.id, conflict.remoteChange.lastEdited);
      return;
    }

    // merge 가 충돌 마커를 남긴 경우(자동 병합 실패) → push 하지 않고 conflict 상태 유지.
    if (!result.success) return;

    // local / merge(성공) / duplicate: 해소된 로컬 본문을 Notion 으로 재push. 해소가 지난
    // 동기화 사본을 해소 결과로 바꿔 두었으므로 «사본과 달라진 것» 은 없다 — 원격에 맞춰
    // 보내도록 알린다(DB 행).
    await this.pusher.pushUpdate(record.obsidianPath, { overwriteRemote: true });
  }
}
