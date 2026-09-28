import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type { RemoteChange, SyncRecord } from "../types/sync.js";
import { snapshotFrontmatter } from "../utils/frontmatter.js";
import type { DatabaseSyncer } from "./database-syncer.js";
import { titleUnchangedSince } from "./note-title.js";
import { rowDatabaseOf } from "./parent-mode.js";
import { remoteBodyFingerprint } from "./remote-observation.js";
import type { RowSchemaCache } from "./row-schema-cache.js";
import type { RunObservation } from "./run-observation.js";

/**
 * 지난번에 본 뒤로 원격에서 바뀐 것(N-05).
 *
 * - `none` — 지난번 그대로다. 쓴 뒤 수정 시각을 올려도 된다.
 * - `outside-body` — 본문은 그대로지만 본문 밖(제목 · 행 속성 · 아이콘 · 커버)이 바뀌었다. 본문은
 *   써도 되지만 수정 시각은 올리지 않는다 — 올리면 다음 pull 이 그 변경을 «이미 받은 것» 으로
 *   여긴다.
 * - `body` — 본문이 바뀌었다.
 * - `unknown` — 지난번 본문의 지문을 몰라 확인하지 못했다.
 */
export type RemoteDrift = "none" | "outside-body" | "body" | "unknown";

/**
 * 원격 본문을 로컬 본문으로 바꿀 수 없으면 던진다 — pull 하지 않은 Notion 편집을 덮어쓰지 않는다
 * (N-05, {@link RemoteDrift}). 예전에는 원격을 보지 않고 바꿨다.
 */
export function refuseUnpulledBody(drift: RemoteDrift, path: string): void {
  if (drift === "body") {
    throw new Error(
      `Notion 에서도 본문이 바뀐 페이지라 올리지 않음 — pull 로 먼저 받은 뒤 다시 push 하세요: ${path}`,
    );
  }
  if (drift === "unknown") {
    throw new Error(
      `Notion 에서 바뀌었는지 확인하지 못한 페이지라 올리지 않음 — pull 로 먼저 받은 뒤 다시 ` +
        `push 하세요: ${path}`,
    );
  }
}

/**
 * 로컬에서 지운 노트의 원격을 지울 수 없으면 던진다 — pull 하지 않은 Notion 편집(본문 · 제목 ·
 * 속성)을 휴지통으로 보내지 않는다(F-f). 본문만 보는 {@link refuseUnpulledBody} 와 달리 본문 밖의
 * 편집도 지키고, 바뀌었는지 모르면 지우지 않는다.
 */
export function refuseUnpulledDeletion(drift: RemoteDrift, path: string): void {
  if (drift === "none") return;
  const reason =
    drift === "unknown"
      ? "Notion 에서 바뀌었는지 확인하지 못한 페이지"
      : "Notion 에서도 바뀐 페이지";
  throw new Error(
    `${reason}라 지우지 않음 — pull 이 되살려 받습니다. 받은 뒤에도 필요 없으면 다시 지우세요: ${path}`,
  );
}

/**
 * 지난번에 본 뒤로 원격이 바뀌었나(N-05) — push 는 pull 하지 않은 Notion 편집을 덮어쓰지 않고,
 * status · dry-run 은 바뀌지 않은 원격을 변경으로 보이지 않는다. 수정 시각 · 편집자로 가를 수
 * 없으면 내용으로 확인한다 — 본문은 지문으로, 본문 밖은 지난 동기화 사본과 견준다.
 */
export class RemoteDriftChecker {
  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
    private readonly databaseSyncer: DatabaseSyncer,
    private readonly rowSchemas: RowSchemaCache,
    private readonly observation: RunObservation,
  ) {}

  /**
   * 원격이 바뀌었는지 확인하지 않고 로컬로 덮어써도 되는가 — 원격을 로컬로 맞추라는 요청이다.
   *
   * - 충돌 해소 결과를 보낼 때 · 입양한 행을 맞출 때(`overwriteRemote`)
   * - 충돌 전략이 local-first 이거나 push 전용일 때 — 설정이 로컬이 이긴다고 정했다
   * - 이 노트가 만든 페이지를 아직 한 번도 맞추지 못했을 때(만들다 끊긴 페이지 · 입양한 고아
   *   페이지) — 견줄 지난 사본이 없고, 페이지는 이 노트가 만든 것이다
   */
  overwritesRemote(record: SyncRecord, overwriteRemote: boolean): boolean {
    return (
      overwriteRemote ||
      this.config.sync.conflictStrategy === "local-first" ||
      this.config.sync.direction === "push" ||
      (record.contentHash === "" && record.notionBodyFingerprint === null)
    );
  }

  /**
   * 지난번에 본 뒤로 원격에서 무엇이 바뀌었나(N-05) — push 가 pull 하지 않은 Notion 편집을
   * 덮어쓰지 않고, 덮어쓰지 않은 원격 변경은 다음 pull 이 받게.
   *
   * 수정 시각 · 편집자로 가를 수 있으면 그것으로 가른다. 바뀌었거나 같은 분 안이라 가를 수 없으면
   * 내용으로 확인한다 — 본문은 지문으로, 본문 밖은 지난 동기화 사본과 견준다. 이 도구가 만든 자식
   * 페이지는 부모의 수정 시각을 올리지만 부모의 본문 · 제목은 그대로다.
   *
   * 본문 밖까지 견주는 이유: 본문만 같다고 수정 시각을 올리지 않으면, 다음 pull 이 방금 올린
   * 본문을 다시 받아 지난 사본과 견준다. 왕복한 본문은 글자 그대로 같지 않아(줄 끝 개행 등)
   * 로컬을 다시 쓰고, 그 사이 로컬을 더 고쳤으면 충돌로 올렸다.
   *
   * @param remote 지금 원격 페이지.
   */
  async remoteDrift(record: SyncRecord, remote: PageObjectResponse): Promise<RemoteDrift> {
    if (this.observation.verdict(record, remote) === "unchanged") return "none";
    const fingerprint = record.notionBodyFingerprint;
    if (fingerprint === null) return "unknown";
    if ((await this.remoteBodyFingerprintOf(record.notionPageId!)) !== fingerprint) return "body";
    return (await this.outsideBodyUnchanged(record, remote)) ? "none" : "outside-body";
  }

  /**
   * 받은 원격이 지난 동기화 사본 그대로인가 — {@link remoteDrift} 와 같은 규칙으로, 본문은 지문으로
   * · 본문 밖은 지난 사본과 견준다. 렌더한 글이 지난 사본과 달라도(이 도구가 만든 자식 페이지의
   * 링크 · 왕복한 본문) 받을 것이 없다.
   *
   * @param fingerprint 받은 원격 본문의 지문. 모르면 null — 그대로라고 보지 않는다.
   */
  async unchangedSinceSync(
    record: SyncRecord,
    remote: PageObjectResponse,
    fingerprint: string | null,
  ): Promise<boolean> {
    return (
      fingerprint !== null &&
      fingerprint === record.notionBodyFingerprint &&
      (await this.outsideBodyUnchanged(record, remote))
    );
  }

  /** 원격 본문을 지금 받아 만든 지문. */
  async remoteBodyFingerprintOf(pageId: string): Promise<string> {
    return remoteBodyFingerprint((await this.notionClient.getPageMarkdown(pageId)).markdown);
  }

  /**
   * «확인 안 됨» 인 원격 변경 중 지난번 그대로인 것을 뺀다 — 받지 않고 변경을 보여 주는 status 와
   * dry-run 이 쓴다. pull 은 받아서 견주므로 쓰지 않는다. push 가 덮어쓰기 전에 보는 것과 같게
   * 견준다({@link remoteDrift}).
   *
   * 원격을 읽지 못했으면 그대로 둔다 — 읽지 못한 것을 바뀌지 않았다고 하지 않는다.
   */
  async withoutUnchangedRemotes(changes: RemoteChange[]): Promise<RemoteChange[]> {
    const kept: RemoteChange[] = [];
    for (const change of changes) {
      const record = change.unverified ? this.stateDb.getByNotionId(change.pageId) : null;
      if (!record) {
        kept.push(change);
        continue;
      }
      try {
        const remote = await this.notionClient.getPage(change.pageId);
        if ((await this.remoteDrift(record, remote)) !== "none") kept.push(change);
      } catch {
        kept.push(change);
      }
    }
    return kept;
  }

  /**
   * 원격의 본문 밖이 지난 동기화 사본 그대로인가 — pull 이 받아 노트에 적는 것 중 본문이 아닌 것.
   * 페이지는 제목뿐이고, 행은 제목과 보낼 수 있는 속성, 그리고 행 렌더러로 받는 행이면 아이콘 ·
   * 커버다. 지난 사본을 읽지 못하면 아니다.
   */
  private async outsideBodyUnchanged(
    record: SyncRecord,
    remote: PageObjectResponse,
  ): Promise<boolean> {
    const base = snapshotFrontmatter(record.baseSnapshot);
    if (base === null) return false;
    const databaseId = rowDatabaseOf(this.config, record);
    if (databaseId === null) {
      return titleUnchangedSince(base, record.obsidianPath, this.notionClient.extractTitle(remote));
    }
    return this.databaseSyncer.rowOutsideBodyUnchanged(
      await this.rowSchemas.mapperFor(databaseId),
      remote,
      base,
      record.obsidianPath,
      record.fileType === "db-row",
    );
  }
}
