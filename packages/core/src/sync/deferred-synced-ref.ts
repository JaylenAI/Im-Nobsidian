import { deferredSyncedRefMarker } from "../constants/markers.js";
import type { NotionClient } from "../notion/client.js";
import { normalizeNotionId } from "../utils/id.js";
import { descendsForDeferred } from "./deferred-code.js";

type DeferredSyncedRefClient = Pick<
  NotionClient,
  "fetchAllChildren" | "appendChildren" | "deleteBlock"
>;

/** 본문을 쓴 뒤 블록 API 로 붙일 동기화 블록 참조 — 자리표시 문단과 참조할 원본 블록. */
export interface DeferredSyncedRef {
  readonly token: string;
  readonly sourceBlockId: string;
}

/** {@link deferSyncedReferences} 의 결과. */
export interface DeferredSyncedRefs {
  /** 참조 자리에 자리표시 문단을 둔 NFM. */
  readonly nfm: string;
  readonly refs: readonly DeferredSyncedRef[];
  /** 빼낸 참조 안의 글 — 그 안의 첨부는 이 페이지가 올릴 것이 아니다. */
  readonly removed: string;
}

// 참조는 겹치지 않는다(동기화 블록 안에 동기화 블록을 둘 수 없다) — 첫 닫는 태그가 짝이다.
const SYNCED_REF_RE =
  /^([\t ]*)<synced_block_reference\s+url="([^"]*)"\s*(?:\/>|>([\s\S]*?)<\/synced_block_reference>)[ \t]*$/gm;

/**
 * 동기화 블록 참조를 본문에서 빼고 그 자리에 자리표시 문단을 둔다(2026-10-22 실데이터 E2E).
 *
 * 참조를 Markdown API(만들기 · 본문 교체)로 보내면 Notion 이 다른 페이지에 있는 원본 동기화 블록의
 * 자식을 보낸 내용으로 다시 만든다 — 같은 글이어도 블록 id 가 바뀌고, 첨부는 자리표시자 글로, 빈 참조는
 * 원본을 비운다(실측). 사용자의 실제 페이지 넷이 이렇게 다시 쓰였다. 참조 안은 원본이 주인이므로 보내지
 * 않고, 본문을 쓴 뒤 참조 블록만 블록 API 로 붙인다({@link fillSyncedReferences}) — 원본은 그대로였다.
 *
 * 원본 블록 id 가 없는 참조는 붙일 수 없어 뺀다(블록 방식 `nfm-to-blocks` 와 같다).
 */
export function deferSyncedReferences(nfm: string, firstIndex = 0): DeferredSyncedRefs {
  const refs: DeferredSyncedRef[] = [];
  let removed = "";
  const replaced = nfm.replace(
    SYNCED_REF_RE,
    (_match, indent: string, url: string, inner: string | undefined) => {
      removed += `${inner ?? ""}\n`;
      const source = /#([0-9a-fA-F-]{32,36})$/.exec(url)?.[1];
      if (source === undefined) return indent;
      const token = deferredSyncedRefMarker(firstIndex + refs.length);
      refs.push({ token, sourceBlockId: normalizeNotionId(source) });
      return `${indent}${token}`;
    },
  );
  return { nfm: replaced, refs, removed };
}

/**
 * 자리표시 문단 뒤에 동기화 블록 참조를 붙이고 자리표시를 지운다 — 본문을 쓴 뒤 부른다. 컨테이너
 * (콜아웃 · 토글 · 목록 · 칼럼) 안의 자리표시는 그 컨테이너에 붙인다.
 *
 * @returns 붙였으면 true — 본문이 바뀌었으니 호출측이 지문 · 수정 시각을 다시 받는다.
 * @throws 자리표시를 다 찾지 못했으면. 그 자리에는 자리표시 글이 남아 있다 — 항목을 실패로 남겨 다음
 *   push 가 본문을 다시 보내게 한다.
 */
export async function fillSyncedReferences(
  client: DeferredSyncedRefClient,
  pageId: string,
  refs: readonly DeferredSyncedRef[],
): Promise<boolean> {
  if (refs.length === 0) return false;
  const pending = new Map(refs.map((r) => [r.token, r.sourceBlockId]));

  const visit = async (parentId: string): Promise<void> => {
    for (const block of await client.fetchAllChildren(parentId)) {
      if (pending.size === 0) return;
      const token =
        block.type === "paragraph"
          ? block.paragraph.rich_text
              .map((t) => t.plain_text)
              .join("")
              .trim()
          : "";
      const source = pending.get(token);
      if (source !== undefined) {
        await client.appendChildren(
          parentId,
          [
            {
              type: "synced_block",
              synced_block: { synced_from: { type: "block_id", block_id: source } },
            },
          ],
          { after: block.id },
        );
        await client.deleteBlock(block.id);
        pending.delete(token);
      } else if (block.has_children && descendsForDeferred(block)) {
        await visit(block.id);
      }
    }
  };
  await visit(pageId);

  if (pending.size > 0) {
    throw new Error(
      `동기화 블록 참조 ${pending.size}개를 Notion 에 붙이지 못함 — 참조 대신 자리표시 글이 남아 있어 ` +
        "다음 push 가 본문을 다시 보낸다",
    );
  }
  return true;
}
