import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import { stripMarkdownExtension } from "../utils/markdown-path.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { isDatabaseMode } from "./parent-mode.js";

/** 오류에 보일 겹친 노트 수 — 나머지는 수로만 알린다. */
const SHOWN_CLASHES = 5;

/**
 * 상태 기록에 Notion 페이지와 이은 노트가 하나도 없는데, 새로 만들 노트가 Notion 에 이미 있는 페이지 · 행과 이름이 겹친다 —
 * 상태 DB 를 잃었거나 처음 잇는 볼트다. 이대로 push 하면 그 노트들을 새 페이지로 또 만든다.
 */
export class UnlinkedVaultError extends Error {
  readonly clashes: readonly string[];

  constructor(clashes: readonly string[]) {
    const shown = clashes.slice(0, SHOWN_CLASHES).join(", ");
    const more = clashes.length > SHOWN_CLASHES ? ` 외 ${clashes.length - SHOWN_CLASHES}개` : "";
    super(
      `상태 기록에 Notion 과 이은 노트가 없는데 Notion 에 같은 이름의 페이지가 이미 있어 올리지 않았습니다(${shown}${more}) — ` +
        "이대로 올리면 같은 페이지를 또 만듭니다. 먼저 pull(또는 sync)로 받으세요: 같은 자리에 같은 글이 있는 노트는 그 " +
        "페이지와 다시 잇고, 글이 다르면 충돌로 남깁니다",
    );
    this.name = "UnlinkedVaultError";
    this.clashes = clashes;
  }
}

/**
 * 새 노트를 만들 push 전에 상태 기록이 비었는지 본다(P7) — 기록이 하나라도 있거나(끊긴 첫 push 의 자리표시 포함) 끝나지 않은
 * 작업이 있으면 바로 돌아간다(요청 없음). 비었으면 만들 노트마다 그 노트의 페이지가 놓일 자리에 같은 이름이 이미 있는지
 * Notion 을 따라 내려가 본다 — 폴더는 같은 이름의 하위 페이지 · DB 로(push 도 폴더 페이지는 제목으로 찾아 쓴다), 노트는 그
 * 아래의 같은 이름 페이지 · 행으로, 폴더 노트(`X/X.md`)는 폴더 페이지 자신으로. 설정한 DB 폴더의 노트는 그 DB 의 행 제목과,
 * DB 모드는 루트 DB 의 행 제목과 견준다. 겹치면 {@link UnlinkedVaultError} 를 던진다. 겹치지 않으면(처음 올리는 볼트 · 다른
 * 이름 · 같은 이름의 빈 폴더 페이지만 있음) 그대로 올린다. push 만 하는 연결은 받을 수 없어 막지 않는다.
 *
 * @param createdPaths 이번 push 가 새로 만들 노트의 볼트 경로.
 * @returns 읽지 못해 확인하지 못한 노트와 그 이유 — 호출측이 그 노트만 실패로 남기고 올리지 않는다(읽지 못함 ≠ 없음).
 */
export async function assertVaultLinked(
  config: Config,
  stateDb: IStateDB,
  notionClient: NotionClient,
  createdPaths: readonly string[],
): Promise<Map<string, string>> {
  const unverified = new Map<string, string>();
  if (config.sync.direction === "push" || createdPaths.length === 0) return unverified;
  if (stateDb.getAll().length > 0 || stateDb.getIncompletePendingOperations().length > 0) {
    return unverified;
  }
  const clashes = await new RemoteTree(notionClient).clashes(config, createdPaths, unverified);
  if (clashes.length > 0) throw new UnlinkedVaultError(clashes);
  return unverified;
}

interface RemoteNode {
  readonly id: string;
  readonly kind: "page" | "database";
}

/** Notion 을 이름으로 따라 내려간다 — 한 번 읽은 자식 목록은 다시 읽지 않는다. */
class RemoteTree {
  private readonly listed = new Map<string, Promise<Map<string, RemoteNode>>>();

  constructor(private readonly notionClient: NotionClient) {}

  async clashes(
    config: Config,
    createdPaths: readonly string[],
    unverified: Map<string, string>,
  ): Promise<string[]> {
    const databases = config.notion.databases ?? [];
    const clashes: string[] = [];
    for (const path of [...createdPaths].sort()) {
      const database = databases.find((db) => path.startsWith(`${db.localFolder}/`));
      const found = await (
        database
          ? this.find({ id: database.databaseId, kind: "database" }, [
              path.slice(database.localFolder.length + 1),
            ])
          : isDatabaseMode(config)
            ? this.find({ id: config.notion.databaseId!, kind: "database" }, [
                path.split("/").pop()!,
              ])
            : this.find({ id: config.notion.rootPageId, kind: "page" }, path.split("/"))
      ).catch((error: unknown) => {
        unverified.set(
          path,
          "상태 기록이 빈 볼트라 Notion 에 같은 페이지가 있는지 먼저 보는데 읽지 못해 올리지 않음: " +
            (error instanceof Error ? error.message : String(error)),
        );
        return false;
      });
      if (found) clashes.push(path);
    }
    return clashes;
  }

  /** `segments`(폴더 … 노트 파일)의 노트 페이지가 `node` 아래에 이미 있나. */
  private async find(node: RemoteNode, segments: readonly string[]): Promise<boolean> {
    let current = node;
    for (const folder of segments.slice(0, -1)) {
      const next = (await this.children(current)).get(sanitizeFileName(folder));
      if (!next) return false;
      current = next;
    }
    const name = sanitizeFileName(stripMarkdownExtension(segments[segments.length - 1]!));
    // 폴더 노트 — 그 폴더 페이지가 이 노트의 페이지다.
    const parentFolder =
      segments.length > 1 ? sanitizeFileName(segments[segments.length - 2]!) : null;
    if (parentFolder === name && current.kind === "page") return true;
    return (await this.children(current)).has(name);
  }

  private children(node: RemoteNode): Promise<Map<string, RemoteNode>> {
    let listed = this.listed.get(node.id);
    if (!listed) {
      listed = node.kind === "database" ? this.rows(node.id) : this.subpages(node.id);
      this.listed.set(node.id, listed);
    }
    return listed;
  }

  private async rows(databaseId: string): Promise<Map<string, RemoteNode>> {
    const rows = new Map<string, RemoteNode>();
    for (const page of await this.notionClient.queryAllDatabasePages(databaseId)) {
      rows.set(sanitizeFileName(this.notionClient.extractTitle(page)), {
        id: page.id,
        kind: "page",
      });
    }
    return rows;
  }

  private async subpages(pageId: string): Promise<Map<string, RemoteNode>> {
    const found = new Map<string, RemoteNode>();
    for (const block of await this.notionClient.fetchAllChildren(pageId)) {
      const child = block as {
        id: string;
        type: string;
        child_page?: { title?: string };
        child_database?: { title?: string };
      };
      if (child.type === "child_page" && child.child_page?.title !== undefined) {
        found.set(sanitizeFileName(child.child_page.title), { id: child.id, kind: "page" });
      } else if (child.type === "child_database" && child.child_database?.title !== undefined) {
        found.set(sanitizeFileName(child.child_database.title), { id: child.id, kind: "database" });
      }
    }
    return found;
  }
}
