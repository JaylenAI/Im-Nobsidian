import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("svelte", () => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock("../src/views/ChangeDiffView.svelte", () => ({ default: { name: "ChangeDiffView" } }));

import { mount, unmount } from "svelte";
import type { ChangeDiff, LocalChange, RemoteChange } from "@im-nobsidian/core";
import { ChangeDiffModal } from "../src/change-diff-modal.js";
import { localDiffSource, remoteDiffSource } from "../src/change-diff-text.js";
import ChangeDiffView from "../src/views/ChangeDiffView.svelte";

const DIFF: ChangeDiff = { path: "채소/감자.md", type: "modified", before: "옛\n", after: "새\n" };

function differ() {
  return {
    localChangeDiff: vi.fn(async (_change: LocalChange) => DIFF),
    remoteChangeDiff: vi.fn(async (_change: RemoteChange) => DIFF),
  };
}

function local(type: LocalChange["type"], path: string, movedFrom?: string): LocalChange {
  return { path, type, currentHash: "h2", previousHash: "h1", ...(movedFrom ? { movedFrom } : {}) };
}

describe("줄 비교 창에 보일 것", () => {
  it("로컬 변경은 노트 이름을 제목으로, 지난 동기화 때의 글과 지금 볼트의 글을 견준다", async () => {
    const d = differ();
    const change = local("modified", "채소/감자.md");
    const source = localDiffSource(change, d);

    expect(source).toMatchObject({
      title: "감자",
      caption: "고친 노트 — 채소/감자.md",
      oldLabel: "지난 동기화",
      newLabel: "지금 볼트",
      emptyText: "지난 동기화 때와 내용이 같습니다",
    });
    await expect(source.load()).resolves.toBe(DIFF);
    expect(d.localChangeDiff).toHaveBeenCalledWith(change);
    expect(d.remoteChangeDiff).not.toHaveBeenCalled();
  });

  it("무엇을 했는지 말한다 — 옮긴 노트는 옛 자리와 새 자리, 내용이 같으면 자리만 옮겼다고", () => {
    const d = differ();

    expect(localDiffSource(local("created", "새.md"), d).caption).toBe("새 노트 — 새.md");
    expect(localDiffSource(local("deleted", "a/지운.md"), d).caption).toBe("지운 노트 — a/지운.md");
    const moved = localDiffSource(local("moved", "B/x.md", "A/x.md"), d);
    expect(moved).toMatchObject({
      title: "x",
      caption: "옮긴 노트 — A/x.md → B/x.md",
      emptyText: "내용은 그대로입니다 — 자리만 옮겼습니다",
    });
  });

  it("원격 변경은 지난 동기화 때의 글과 Notion 의 지금 글을 견준다", async () => {
    const d = differ();
    const change: RemoteChange = {
      pageId: "p1",
      type: "deleted",
      path: "과일/사과.md",
      lastEdited: "t2",
    };
    const source = remoteDiffSource(change, d);

    expect(source).toMatchObject({
      title: "사과",
      caption: "Notion 에서 지운 노트 — 과일/사과.md",
      oldLabel: "지난 동기화",
      newLabel: "Notion 지금",
    });
    await source!.load();
    expect(d.remoteChangeDiff).toHaveBeenCalledWith(change);
    expect(d.localChangeDiff).not.toHaveBeenCalled();
  });

  it("아직 받지 않은 새 페이지는 견줄 지난 글이 없어 창을 만들지 않는다", () => {
    const change: RemoteChange = {
      pageId: "p2",
      type: "created",
      title: "새 페이지",
      lastEdited: "t",
    };
    expect(remoteDiffSource(change, differ())).toBeNull();
  });
});

describe("ChangeDiffModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mount).mockImplementation(() => ({}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("열면 제목 · 무엇을 했는지 · 줄 비교를 놓고, 넓은 창으로 연다", () => {
    const source = localDiffSource(local("modified", "채소/감자.md"), differ());
    const modal = new ChangeDiffModal({} as never, source);
    const addClass = vi.spyOn(modal.modalEl as { addClass: () => void }, "addClass");
    const createEl = vi.spyOn(modal.contentEl as { createEl: () => unknown }, "createEl");

    modal.onOpen();

    expect(addClass).toHaveBeenCalledWith("im-nobsidian-change-diff-modal");
    expect(
      createEl.mock.calls.map(([tag, options]) => [tag, (options as { text: string }).text]),
    ).toEqual([
      ["h2", "감자"],
      ["p", "고친 노트 — 채소/감자.md"],
    ]);
    expect(mount).toHaveBeenCalledTimes(1);
    const [component, options] = vi.mocked(mount).mock.calls[0]!;
    expect(component).toBe(ChangeDiffView);
    expect(options.props).toEqual({
      load: source.load,
      oldLabel: "지난 동기화",
      newLabel: "지금 볼트",
      emptyText: "지난 동기화 때와 내용이 같습니다",
    });
  });

  it("닫으면 줄 비교를 한 번만 내린다", () => {
    const modal = new ChangeDiffModal(
      {} as never,
      localDiffSource(local("created", "새.md"), differ()),
    );
    modal.onOpen();
    modal.close();
    modal.close();

    expect(unmount).toHaveBeenCalledTimes(1);
  });
});
