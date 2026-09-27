/**
 * S-03 — 자식 페이지 · 자식 DB 가 있는 페이지의 본문 push.
 *
 * 예전에는 자식이 있으면 본문 push 를 통째로 건너뛰고도 동기화됨으로 기록해, 폴더 노트에서
 * 고친 내용이 Notion 에 영영 가지 않았다. 이제는 삭제를 허용하지 않고 보내고(자식이 있으면
 * Notion 이 아무것도 바꾸지 않고 거절한다), 거절되면 자식 태그를 제자리에 되돌려 다시 보낸다.
 */
import { describe, it, expect, vi } from "vitest";
import { replacePageBody } from "../../src/sync/page-body.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { rewriteDbPlaceholders } from "../../src/sync/db-placeholder-rewriter.js";

const PAGE_ID = "3e813b18d38281a3a1f2c3d4e5f60eb0";
const DB_ID = "060db215aaaa4bbbbcccc1234567d466";
const PAGE_TAG = `<page url="https://app.notion.com/p/${PAGE_ID}">S03 자식 페이지</page>`;
const DB_TAG = `<database url="https://app.notion.com/p/${DB_ID}" inline="true" data-source-url="collection://16a332b6-0000-4000-8000-00000000dabd">S03 자식 DB</database>`;
/** Notion 이 돌려주는 본문 — 블록 사이 빈 줄 없이, 자식은 태그로. */
const REMOTE = `첫 문단 A\n## 제목 H\n둘째 문단 B\n${PAGE_TAG}\n${DB_TAG}\n`;

function validationError(message: string): Error {
  return Object.assign(new Error(message), { code: "validation_error", status: 400 });
}

const WOULD_DELETE = validationError(
  "This operation would delete 2 child page(s), database(s), or meeting note(s): …",
);

function clientWith(remote: string, ...replies: Array<Error | undefined>) {
  const replacePageMarkdown = vi.fn();
  for (const reply of replies) {
    if (reply) replacePageMarkdown.mockRejectedValueOnce(reply);
    else replacePageMarkdown.mockResolvedValueOnce({ markdown: "" });
  }
  return {
    replacePageMarkdown,
    getPageMarkdown: vi
      .fn()
      .mockResolvedValue({ markdown: remote, truncated: false, unknown_block_ids: [] }),
  };
}

describe("replacePageBody — 자식을 지우지 않고 본문 교체 (S-03)", () => {
  it("자식이 없는 페이지는 한 번 보내고 끝 — 추가 조회 없음", async () => {
    const client = clientWith("", undefined);
    await replacePageBody(client as never, "p", "본문");
    expect(client.replacePageMarkdown).toHaveBeenCalledTimes(1);
    expect(client.getPageMarkdown).not.toHaveBeenCalled();
  });

  it("삭제 거절이면 지금 본문의 자식 태그를 제자리에 되돌려 다시 보낸다", async () => {
    const client = clientWith(REMOTE, WOULD_DELETE, undefined);
    const local = `첫 문단 A1\n\n[[S03 자식 페이지]]\n\n**S03 자식 DB** *(Notion DB)*%%im-nobsidian:child-database:id=${DB_ID}%%\n`;

    await replacePageBody(client as never, "p", local);

    expect(client.getPageMarkdown).toHaveBeenCalledWith("p");
    expect(client.replacePageMarkdown).toHaveBeenCalledTimes(2);
    expect(client.replacePageMarkdown.mock.calls[1]![1]).toBe(
      `첫 문단 A1\n\n${PAGE_TAG}\n\n${DB_TAG}\n`,
    );
  });

  it("다시 보내도 거절되면 Notion 이 말한 사유를 담아 실패로 올린다", async () => {
    const client = clientWith(
      REMOTE,
      WOULD_DELETE,
      validationError("Content exceeds the maximum length."),
    );
    await expect(replacePageBody(client as never, "p", "[[S03 자식 페이지]]\n")).rejects.toThrow(
      /본문 교체를 거절.*Content exceeds the maximum length\./,
    );
  });

  it("되돌릴 자식이 없으면 처음 거절을 그대로 올린다 — 사유를 뭉개지 않는다", async () => {
    const other = validationError("body.children should be defined");
    const client = clientWith("자식 없는 본문\n", other);
    await expect(replacePageBody(client as never, "p", "본문")).rejects.toBe(other);
    expect(client.replacePageMarkdown).toHaveBeenCalledTimes(1);
  });

  it("거절이 아닌 오류(5xx · 연결)는 되돌리기를 시도하지 않고 그대로 올린다", async () => {
    const outage = Object.assign(new Error("Bad Gateway"), { status: 502 });
    const client = clientWith(REMOTE, outage);
    await expect(replacePageBody(client as never, "p", "본문")).rejects.toBe(outage);
    expect(client.getPageMarkdown).not.toHaveBeenCalled();
  });

  it(".base 임베드는 DB id 로 맞춘다 — 자식 DB 가 있을 때만, .base 경로만 묻는다", async () => {
    const client = clientWith(REMOTE, WOULD_DELETE, undefined);
    const databaseIdsOfBase = vi.fn().mockResolvedValue([DB_ID]);
    const local =
      "> 📎 다른 이름.base %% im-nobsidian:local-file:%ED%8F%B4%EB%8D%94%2F%EB%8B%A4%EB%A5%B8%20%EC%9D%B4%EB%A6%84.base %%\n\n[[S03 자식 페이지]]\n";

    await replacePageBody(client as never, "p", local, { databaseIdsOfBase });

    expect(databaseIdsOfBase).toHaveBeenCalledTimes(1);
    expect(databaseIdsOfBase).toHaveBeenCalledWith("폴더/다른 이름.base");
    expect(client.replacePageMarkdown.mock.calls[1]![1]).toBe(`${DB_TAG}\n\n${PAGE_TAG}\n`);
  });
});

describe("pull 이 만든 폴더 노트를 고쳐 push 하면 자식이 제자리로 돌아간다 (실제 변환기)", () => {
  const BASE_PATH = "S-03 프로브/S03-자식-DB/S03 자식 DB.base";
  const context = (direction: "push" | "pull") =>
    ({
      direction,
      path: "markdown-api",
      filePath: "S-03 프로브/S-03 프로브.md",
      parentMode: "page",
    }) as const;
  const resolveDb = (id: string) =>
    id === DB_ID ? { basePath: BASE_PATH, title: "S03 자식 DB" } : null;

  it("다시 받아도 .base 임베드 아래에 첨부 마커 줄이 남지 않는다 — push 가 저장한 마커", () => {
    const local = `첫 문단 A1\n\n## 제목 H\n\n둘째 문단 B\n\n![[${BASE_PATH}|S03 자식 DB]]`;
    const pipeline = createDefaultPipeline();
    const pushed = pipeline.convertToNotion(local, context("push"));
    // 전제: push 는 .base 임베드를 로컬 첨부로 보고 보존 마커를 남긴다(pull 때 되살릴 후보).
    expect(pushed.preserveMarkers.some((m) => m.type === "local-file")).toBe(true);

    // Notion 이 받은 본문 — 자리표시자 자리에 자식 DB 태그가 되돌아가 있다.
    const remote = `첫 문단 A1\n## 제목 H\n둘째 문단 B\n${DB_TAG}\n`;
    const pulled = pipeline.convertToMarkdown(notionEnhancedToObsidian(remote), context("pull"), {
      preserveMarkers: pushed.preserveMarkers,
    });
    const { content } = rewriteDbPlaceholders(pulled, resolveDb);

    expect(content).not.toContain("local-file");
    expect(content.trimEnd()).toBe(local);
  });

  it("[[자식]] · .base 임베드가 태그로, 고친 문단은 그대로", () => {
    // pull — Notion 본문 → 볼트 (인라인 DB 자리는 .base 임베드로 재작성)
    const pulled = rewriteDbPlaceholders(notionEnhancedToObsidian(REMOTE), resolveDb).content;
    expect(pulled).toContain("[[S03 자식 페이지]]");
    expect(pulled).toContain(`![[${BASE_PATH}|S03 자식 DB]]`);

    // 사용자가 옵시디언에서 첫 문단을 고친다
    const edited = pulled.replace("첫 문단 A", "첫 문단 A — 옵시디언에서 수정");

    // push — 볼트 → Notion 본문 (자식 페이지는 추적 중이라 멘션으로 해석된다)
    const pipeline = createDefaultPipeline({
      wikilinkResolver: (text) =>
        text === "S03 자식 페이지"
          ? {
              obsidianPath: "S-03 프로브/S03 자식 페이지.md",
              notionPageId: PAGE_ID,
              title: "S03 자식 페이지",
              aliases: [],
            }
          : null,
    });
    const converted = pipeline.convertToNotion(edited, {
      ...context("push"),
      path: pipeline.selectPath(edited),
    });
    const outgoing = obsidianToNotionEnhanced(converted.content);
    expect(outgoing).not.toContain("<page ");

    const client = clientWith(REMOTE, WOULD_DELETE, undefined);
    return replacePageBody(client as never, "p", outgoing).then(() => {
      const sent = client.replacePageMarkdown.mock.calls[1]![1] as string;
      const order = sent
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => (l === PAGE_TAG ? "PAGE" : l === DB_TAG ? "DB" : l));
      expect(order).toEqual([
        "첫 문단 A — 옵시디언에서 수정",
        "## 제목 H",
        "둘째 문단 B",
        "PAGE",
        "DB",
      ]);
    });
  });
});
