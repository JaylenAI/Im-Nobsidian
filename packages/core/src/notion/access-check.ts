import {
  isNotionAccessDenied,
  isNotionObjectNotFound,
  isTrashedOrArchived,
  notionStatusOf,
  type NotionClient,
} from "./client.js";
import { titleRunsOf } from "./rich-text.js";

/** Notion 에 닿는지 확인한 결과 — 읽은 것과 읽지 못한 까닭을 사람이 읽는 줄로. */
export interface NotionAccessCheck {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/** 무엇을 확인하나 — 루트 페이지, DB 모드면 그 DB. 빈 값은 건너뛴다. */
export interface NotionAccessTarget {
  readonly rootPageId: string;
  readonly databaseId?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnauthorized(error: unknown): boolean {
  return (
    notionStatusOf(error) === 401 || (error as { code?: unknown } | null)?.code === "unauthorized"
  );
}

/**
 * 루트 페이지 · DB 를 읽지 못한 까닭 — 고칠 곳을 말한다. 「없다」 와 「공유하지 않았다」 는 Notion 이 같은 404 로 준다.
 * @param what 목적격 조사까지 — 「루트 페이지를」 · 「DB 를」
 */
function unreadable(what: string, error: unknown): string {
  if (isNotionObjectNotFound(error)) {
    return (
      `${what} 읽지 못했습니다 — 없거나 이 통합에 공유하지 않았습니다. Notion 에서 그 페이지의 ••• → 연결(Connections)에 ` +
      `이 통합을 추가하세요.`
    );
  }
  if (isNotionAccessDenied(error)) {
    return `이 통합에 ${what} 읽는 권한이 없습니다 — 통합 설정의 기능(Capabilities)에서 콘텐츠 읽기를 켜세요.`;
  }
  return `${what} 읽지 못했습니다 — ${messageOf(error)}`;
}

/**
 * 토큰이 맞는지, 루트 페이지(DB 모드면 DB)를 읽을 수 있는지 Notion 에 묻는다 — 첫 동기화에서야 알던 것을 미리.
 * 아무것도 쓰지 않는다. 쓰기 권한은 쓰지 않고는 알 수 없어 확인하지 않는다.
 */
export async function checkNotionAccess(
  client: NotionClient,
  target: NotionAccessTarget,
): Promise<NotionAccessCheck> {
  try {
    await client.getBotUserId();
  } catch (error) {
    return {
      ok: false,
      lines: [
        isUnauthorized(error)
          ? "토큰이 맞지 않습니다 — Notion 의 통합 설정(Integrations)에서 Internal Integration Secret 을 다시 복사해 넣으세요."
          : `Notion 에 닿지 못했습니다 — ${messageOf(error)}`,
      ],
    };
  }
  const lines = ["토큰이 맞습니다."];
  let ok = true;

  if (target.rootPageId) {
    try {
      const page = await client.getPage(target.rootPageId);
      const title = (titleRunsOf(page.properties) ?? []).map((run) => run.plain_text).join("");
      if (isTrashedOrArchived(page)) {
        ok = false;
        lines.push(
          `루트 페이지 「${title || "제목 없음"}」 — Notion 휴지통에 있습니다. 꺼내거나 다른 페이지를 고르세요.`,
        );
      } else {
        lines.push(`루트 페이지 「${title || "제목 없음"}」 — 읽을 수 있습니다.`);
      }
    } catch (error) {
      ok = false;
      lines.push(unreadable("루트 페이지를", error));
    }
  }

  if (target.databaseId) {
    try {
      const title = await client.getDatabaseTitle(target.databaseId);
      lines.push(`DB 「${title || "제목 없음"}」 — 읽을 수 있습니다.`);
    } catch (error) {
      ok = false;
      lines.push(unreadable("DB 를", error));
    }
  }
  return { ok, lines };
}
