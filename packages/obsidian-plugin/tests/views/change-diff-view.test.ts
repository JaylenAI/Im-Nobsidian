// @vitest-environment happy-dom
/**
 * 줄 비교 — 변경 패널의 줄 비교 창과 충돌 창이 쓰는 두 컴포넌트를 실제로 마운트해 본다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { lineDiff } from "@im-nobsidian/core";
import type { ChangeDiff } from "@im-nobsidian/core";
import DiffLines from "../../src/views/DiffLines.svelte";
import ChangeDiffView from "../../src/views/ChangeDiffView.svelte";
import { renderComponent, normText, type Mounted } from "../helpers/mount-svelte.js";

let m: Mounted | null = null;

afterEach(() => {
  m?.destroy();
  m = null;
});

const LABELS = { oldLabel: "지난 동기화", newLabel: "지금 볼트", emptyText: "내용이 같습니다" };

/** 줄마다 「옛 번호|새 번호|부호|글」 — 글 끝 줄바꿈이 없다는 표시가 있으면 「|↵ 없음」 을 붙인다. */
function rows(target: HTMLElement): string[] {
  return [...target.querySelectorAll(".im-nobsidian-diff-line")].map((line) => {
    const [oldNumber, newNumber] = [...line.querySelectorAll(".im-nobsidian-diff-num")].map(
      (el) => el.textContent,
    );
    const sign = line.querySelector(".im-nobsidian-diff-sign")?.textContent;
    const text = line.querySelector(".im-nobsidian-diff-text")?.textContent;
    const eol = line.querySelector(".im-nobsidian-diff-eol") ? "|↵ 없음" : "";
    return `${oldNumber}|${newNumber}|${sign}|${text}${eol}`;
  });
}

function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `줄 ${i + 1}\n`).join("");
}

/** 불러오기가 끝나 `{#await}` 가 다시 그려질 때까지 기다린다. */
async function settle(mounted: Mounted): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  mounted.flush();
}

describe("DiffLines", () => {
  it("바뀐 줄만 지운 줄 · 더한 줄로 보이고, 둘레 줄은 그대로 두며 양쪽 줄 번호를 단다", () => {
    m = renderComponent(DiffLines, { hunks: lineDiff("가\n나\n다\n", "가\n너\n다\n"), ...LABELS });

    expect(normText(m.target.querySelector(".im-nobsidian-diff-header"))).toBe(
      "- 지난 동기화 + 지금 볼트",
    );
    expect(rows(m.target)).toEqual(["1|1| |가", "2||-|나", "|2|+|너", "3|3| |다"]);
    const kinds = [...m.target.querySelectorAll(".im-nobsidian-diff-line")].map(
      (line) => line.classList[1],
    );
    expect(kinds).toEqual([
      "im-nobsidian-diff-same",
      "im-nobsidian-diff-removed",
      "im-nobsidian-diff-added",
      "im-nobsidian-diff-same",
    ]);
    // 글 처음부터 보이므로 접은 줄이 없다
    expect(m.target.querySelector(".im-nobsidian-diff-gap")).toBeNull();
  });

  it("바뀌지 않아 접은 줄마다 ⋯ 를 둔다 — 글 처음과 두 묶음 사이", () => {
    const before = numbered(20);
    const after = before.replace("줄 10\n", "줄 10 고침\n").replace("줄 20\n", "줄 20 고침\n");
    m = renderComponent(DiffLines, { hunks: lineDiff(before, after), ...LABELS });

    expect(m.target.querySelectorAll(".im-nobsidian-diff-gap")).toHaveLength(2);
    expect(rows(m.target)[0]).toBe("7|7| |줄 7");
  });

  it("두 글이 같으면 줄 대신 그렇다고 알린다", () => {
    m = renderComponent(DiffLines, { hunks: lineDiff("같은 글\n", "같은 글\n"), ...LABELS });

    expect(normText(m.target.querySelector(".im-nobsidian-diff-status"))).toBe("내용이 같습니다");
    expect(m.target.querySelector(".im-nobsidian-diff-body")).toBeNull();
  });

  it("글 끝 줄바꿈만 바뀌어도 보인다 — 줄바꿈이 없는 쪽에 표시한다", () => {
    m = renderComponent(DiffLines, { hunks: lineDiff("끝 줄\n", "끝 줄"), ...LABELS });

    expect(rows(m.target)).toEqual(["1||-|끝 줄", "|1|+|끝 줄|↵ 없음"]);
  });
});

describe("ChangeDiffView", () => {
  it("불러오는 동안 알리고, 불러오면 지난 글과 지금 글을 견준다 — 한 번만 부른다", async () => {
    let resolve!: (diff: ChangeDiff) => void;
    const load = vi.fn(() => new Promise<ChangeDiff>((done) => (resolve = done)));
    m = renderComponent(ChangeDiffView, { load, ...LABELS });

    expect(normText(m.target)).toBe("불러오는 중…");
    resolve({ path: "a.md", type: "modified", before: "옛 줄\n", after: "새 줄\n" });
    await settle(m);

    expect(rows(m.target)).toEqual(["1||-|옛 줄", "|1|+|새 줄"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("새 노트는 모든 줄을 더한 줄로, 지운 노트는 모든 줄을 지운 줄로 보인다", async () => {
    m = renderComponent(ChangeDiffView, {
      load: async (): Promise<ChangeDiff> => ({
        path: "새.md",
        type: "created",
        before: null,
        after: "첫 줄\n둘째 줄\n",
      }),
      ...LABELS,
    });
    await settle(m);
    expect(rows(m.target)).toEqual(["|1|+|첫 줄", "|2|+|둘째 줄"]);
    m.destroy();

    m = renderComponent(ChangeDiffView, {
      load: async (): Promise<ChangeDiff> => ({
        path: "지운.md",
        type: "deleted",
        before: "지울 글\n",
        after: null,
      }),
      ...LABELS,
    });
    await settle(m);
    expect(rows(m.target)).toEqual(["1||-|지울 글"]);
  });

  it("불러오지 못하면 이유를 그대로 보인다 — 무엇을 해야 할지 알 수 있게", async () => {
    const reason =
      "지난 동기화 기록이 변경 목록과 맞지 않습니다 — 새로고침한 뒤 다시 보세요 (a.md)";
    m = renderComponent(ChangeDiffView, {
      load: () => Promise.reject(new Error(reason)),
      ...LABELS,
    });
    await settle(m);

    expect(normText(m.target.querySelector(".im-nobsidian-diff-error"))).toBe(reason);
    expect(m.target.querySelector(".im-nobsidian-diff-line")).toBeNull();
  });

  it("자리만 옮긴 노트처럼 두 글이 같으면 그렇다고 알린다", async () => {
    m = renderComponent(ChangeDiffView, {
      load: async (): Promise<ChangeDiff> => ({
        path: "B/x.md",
        type: "moved",
        movedFrom: "A/x.md",
        before: "본문\n",
        after: "본문\n",
      }),
      ...LABELS,
      emptyText: "내용은 그대로입니다 — 자리만 옮겼습니다",
    });
    await settle(m);

    expect(normText(m.target.querySelector(".im-nobsidian-diff-status"))).toBe(
      "내용은 그대로입니다 — 자리만 옮겼습니다",
    );
  });
});
