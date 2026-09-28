import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("svelte", () => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock("../src/views/DiffLines.svelte", () => ({ default: { name: "DiffLines" } }));

import { Setting } from "obsidian";
import { mount, unmount } from "svelte";
import { ConflictModal } from "../src/conflict-modal.js";
import DiffLines from "../src/views/DiffLines.svelte";
import type { Conflict, DiffHunk } from "@im-nobsidian/core";

describe("ConflictModal", () => {
  let modal: ConflictModal;
  let onResolve: ReturnType<typeof vi.fn>;
  let mockConflict: Conflict;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mount).mockImplementation(() => ({}));

    onResolve = vi.fn();
    mockConflict = {
      syncRecord: {
        id: "rec-1",
        obsidianPath: "notes/conflict.md",
        notionPageId: "page-1",
        notionParentId: null,
        contentHash: "h1",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "conflict",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
        version: 1,
        createdAt: "2026-05-22T00:00:00Z",
        updatedAt: "2026-05-22T00:00:00Z",
      },
      localChange: {
        path: "notes/conflict.md",
        type: "modified",
        currentHash: "h2",
        previousHash: "h1",
      },
      remoteChange: {
        pageId: "page-1",
        type: "modified",
        lastEdited: "2026-05-22T01:00:00Z",
        previousEdited: "2026-05-22T00:00:00Z",
      },
      baseContent: "base content",
      localContent: "local line 1\nlocal line 2",
      remoteContent: "remote line 1\nremote line 2",
    } as Conflict;

    modal = new ConflictModal({} as never, mockConflict, onResolve);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 연 모달이 놓은 단추의 이름 · 설명과, 본문에 만든 문단 · 줄 비교. */
  function opened(conflict: Conflict) {
    const names = vi.spyOn(Setting.prototype, "setName");
    const descs = vi.spyOn(Setting.prototype, "setDesc");
    const target = new ConflictModal({} as never, conflict, vi.fn());
    const createEl = vi.spyOn(target.contentEl as { createEl: () => unknown }, "createEl");
    target.onOpen();
    return {
      labels: names.mock.calls.map(([label]) => label),
      descriptions: descs.mock.calls.map(([description]) => description),
      paragraphs: createEl.mock.calls
        .filter(([tag]) => tag === "p")
        .map(([, options]) => (options as { text: string }).text),
      diffs: vi.mocked(mount).mock.calls.map(([component, options]) => ({
        component,
        props: options.props as {
          hunks: DiffHunk[];
          oldLabel: string;
          newLabel: string;
          emptyText: string;
        },
      })),
    };
  }

  /** 줄 비교의 줄을 「종류:글」 로 — 어느 줄을 더하고 지웠는지만 본다. */
  function diffLines(hunks: DiffHunk[]): string[] {
    return hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind}:${line.text}`));
  }

  it("양쪽을 고친 충돌은 로컬과 원격의 줄 비교와 네 가지 단추를 놓는다", () => {
    const view = opened(mockConflict);

    expect(view.labels).toEqual(["로컬 유지", "원격 유지", "자동 병합", "복제"]);
    expect(view.diffs).toHaveLength(1);
    expect(view.diffs[0]!.component).toBe(DiffLines);
    expect(view.diffs[0]!.props).toMatchObject({
      oldLabel: "로컬 (Obsidian)",
      newLabel: "원격 (Notion)",
    });
    expect(diffLines(view.diffs[0]!.props.hunks)).toEqual([
      "removed:local line 1",
      "removed:local line 2",
      "added:remote line 1",
      "added:remote line 2",
    ]);
  });

  it("원격이 맨 위에 한 줄을 끼웠으면 그 줄만 더한 것으로 보인다 — 아래 줄을 모두 바뀐 것으로 보이지 않는다", () => {
    const view = opened({
      ...mockConflict,
      localContent: "첫 줄\n둘째 줄\n",
      remoteContent: "끼운 줄\n첫 줄\n둘째 줄\n",
    });

    expect(diffLines(view.diffs[0]!.props.hunks)).toEqual([
      "added:끼운 줄",
      "same:첫 줄",
      "same:둘째 줄",
    ]);
  });

  it("Notion 에서 지운 노트는 줄 비교 대신 알리고, 로컬 유지 · 삭제 따르기 둘만 놓는다 (D)", () => {
    const view = opened({
      ...mockConflict,
      remoteChange: { ...mockConflict.remoteChange, type: "deleted" },
      remoteContent: "",
    });

    expect(view.labels).toEqual(["로컬 유지", "삭제 따르기"]);
    expect(view.descriptions).toEqual([
      "Obsidian 파일을 그대로 두고 Notion 에 새 페이지로 다시 만듭니다",
      "Notion 에서 지운 대로 Obsidian 파일도 지웁니다",
    ]);
    expect(view.paragraphs).toContain(
      "Notion 에서 삭제된 노트입니다 — Notion 에 올리지 않은 로컬 편집이 남아 있습니다.",
    );
    expect(view.diffs).toEqual([]);
  });

  it("onOpen 에러 없이 실행", () => {
    expect(() => modal.onOpen()).not.toThrow();
  });

  it("onClose 에러 없이 실행", () => {
    expect(() => modal.onClose()).not.toThrow();
  });

  it("인스턴스 생성 가능", () => {
    expect(modal).toBeDefined();
  });

  it("onOpen 호출 후 onClose 호출 가능", () => {
    modal.onOpen();
    expect(() => modal.onClose()).not.toThrow();
  });

  it("닫으면 줄 비교를 한 번만 내린다", () => {
    modal.onOpen();
    modal.close();
    modal.close();

    expect(unmount).toHaveBeenCalledTimes(1);
  });

  it("고르지 않고 닫으면(Esc · 바깥 클릭) 고르지 않았다고 한 번 알린다 (N-06)", () => {
    modal.onOpen();
    modal.close();
    modal.close();

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(null);
  });

  it("단추로 고르면 고른 것만 알린다 — 닫히며 다시 알리지 않는다", () => {
    modal.onOpen();
    (modal as unknown as { selectChoice(choice: string): void }).selectChoice("local");

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith("local");
  });

  it("다른 충돌 데이터로도 생성 가능", () => {
    const anotherConflict = {
      ...mockConflict,
      localContent: "different local",
      remoteContent: "different remote",
    } as Conflict;

    const anotherModal = new ConflictModal({} as never, anotherConflict, vi.fn());
    expect(anotherModal).toBeDefined();
    expect(() => anotherModal.onOpen()).not.toThrow();
  });
});
