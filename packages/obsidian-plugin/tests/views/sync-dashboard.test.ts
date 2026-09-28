// @vitest-environment happy-dom
/**
 * I9 — SyncDashboard 상태/진행률/에러 일관 표시.
 * "설정·진행률·에러 일관 표시" 불변식을 실제 마운트로 단언한다:
 *   - ready/syncing/error/conflict 상태 라벨·data-state
 *   - 진행률 퍼센트 + current/total + 파일명
 *   - 에러 메시지 노출
 *   - onReady 업데이터를 통한 동적 갱신(완료 배너) — SyncController 가 구동하는 실제 경로
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import SyncDashboard from "../../src/views/SyncDashboard.svelte";
import { renderComponent, normText, type Mounted } from "../helpers/mount-svelte.js";

interface SyncStateUpdate {
  lastSyncAt: string | null;
  localChanges: unknown[];
  remoteChanges?: unknown[];
  conflictRecords: unknown[];
  syncState: "ready" | "syncing" | "error" | "conflict";
  operationType: "pull" | "push" | "sync" | null;
  progress: { current: number; total: number; currentPath: string } | null;
  errorMessage: string | null;
  completionSummary: string | null;
}

let m: Mounted | null = null;
let updater: ((s: SyncStateUpdate) => void) | null = null;

afterEach(() => {
  m?.destroy();
  m = null;
  updater = null;
});

function baseProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    lastSyncAt: null,
    localChanges: [],
    remoteChanges: [],
    conflictRecords: [],
    syncState: "ready",
    operationType: null,
    progress: null,
    errorMessage: null,
    completionSummary: null,
    onReady: (fn: (s: SyncStateUpdate) => void) => {
      updater = fn;
    },
    onPull: vi.fn(),
    onPush: vi.fn(),
    onSync: vi.fn(),
    onRefresh: vi.fn(),
    onCancel: vi.fn(),
    onOpenFile: vi.fn(),
    onPushPath: vi.fn(),
    onDiscard: vi.fn(),
    onPullPath: vi.fn(),
    onShowLocalDiff: vi.fn(),
    onShowRemoteDiff: vi.fn(),
    onResolveConflict: vi.fn(),
    ...overrides,
  };
}

describe("SyncDashboard (I9 마운트)", () => {
  it("ready 상태: data-state=ready + '준비됨' 라벨", () => {
    m = renderComponent(SyncDashboard, baseProps());
    const status = m.target.querySelector(".im-sync-status");
    expect(status?.getAttribute("data-state")).toBe("ready");
    expect(normText(m.target.querySelector(".im-sync-status-label"))).toBe("준비됨");
  });

  it("error 상태: data-state=error + 에러 메시지 노출", () => {
    m = renderComponent(
      SyncDashboard,
      baseProps({ syncState: "error", errorMessage: "토큰 만료" }),
    );
    expect(m.target.querySelector(".im-sync-status")?.getAttribute("data-state")).toBe("error");
    expect(normText(m.target.querySelector(".im-sync-error"))).toBe("토큰 만료");
  });

  it("syncing + progress: 퍼센트 + current/total + 파일명 표시", () => {
    m = renderComponent(
      SyncDashboard,
      baseProps({
        syncState: "syncing",
        operationType: "pull",
        progress: { current: 3, total: 10, currentPath: "채소/감자.md" },
      }),
    );
    expect(m.target.querySelector(".im-sync-status")?.getAttribute("data-state")).toBe("syncing");
    expect(normText(m.target.querySelector(".im-sync-progress-pct"))).toBe("30%");
    const progressText = normText(m.target.querySelector(".im-sync-progress-text"));
    expect(progressText).toContain("3/10");
    expect(progressText).toContain("감자"); // fileName() 이 .md 확장자를 제거
  });

  it("conflict 상태: 충돌 건수 라벨 + 충돌 기록의 노트 목록 + 해결 단추", () => {
    const conflictRecords = [
      { id: "r1", obsidianPath: "채소/감자.md" },
      { id: "r2", obsidianPath: "채소/당근.md" },
    ];
    const props = baseProps({ syncState: "conflict", conflictRecords });
    m = renderComponent(SyncDashboard, props);
    expect(normText(m.target.querySelector(".im-sync-status-label"))).toBe("충돌 2건");
    expect(normText(m.target.querySelector(".im-sync-badge-warn"))).toBe("2");
    const items = [...m.target.querySelectorAll(".im-sync-conflict-item")];
    expect(items.map((item) => normText(item))).toEqual(["C 감자", "C 당근"]);
    expect(
      items.map((item) => item.querySelector(".im-sync-file-name")?.getAttribute("title")),
    ).toEqual(["채소/감자.md", "채소/당근.md"]);
    m.target.querySelector<HTMLElement>(".im-sync-resolve-btn")!.click();
    expect(props.onResolveConflict).toHaveBeenCalledTimes(1);
  });

  it("충돌 기록이 비면 목록과 해결 단추가 사라진다", () => {
    m = renderComponent(
      SyncDashboard,
      baseProps({
        syncState: "conflict",
        conflictRecords: [{ id: "r1", obsidianPath: "배추.md" }],
      }),
    );
    expect(m.target.querySelector(".im-sync-resolve-btn")).not.toBeNull();

    updater!({
      lastSyncAt: null,
      localChanges: [],
      conflictRecords: [],
      syncState: "ready",
      operationType: null,
      progress: null,
      errorMessage: null,
      completionSummary: null,
    });
    m.flush();

    expect(m.target.querySelector(".im-sync-section-conflict")).toBeNull();
    expect(normText(m.target.querySelector(".im-sync-status-label"))).toBe("준비됨");
  });

  it("onReady 업데이터로 완료 요약을 동적 갱신하면 완료 배너가 보인다", () => {
    m = renderComponent(SyncDashboard, baseProps());
    expect(m.target.querySelector(".im-sync-completion")).toBeNull();
    expect(updater).not.toBeNull();

    updater!({
      lastSyncAt: "2026-05-30T00:00:00.000Z",
      localChanges: [],
      remoteChanges: [],
      conflictRecords: [],
      syncState: "ready",
      operationType: "pull",
      progress: null,
      errorMessage: null,
      completionSummary: "Pull 완료 · 5개 생성",
    });
    m.flush();

    expect(normText(m.target.querySelector(".im-sync-completion"))).toContain(
      "Pull 완료 · 5개 생성",
    );
  });

  it("새로고침 버튼 클릭 시 onRefresh 호출", () => {
    const props = baseProps();
    m = renderComponent(SyncDashboard, props);
    m.target.querySelector<HTMLElement>(".im-sync-refresh-btn")!.click();
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("변경 패널 — 항목별 동작", () => {
  const PULL = 'button[aria-label="이 노트만 Notion 에서 받기"]';
  const PULL_DELETION = 'button[aria-label="Notion 에서 지운 대로 이 노트도 지우기"]';
  const PUSH = 'button[aria-label="이 노트만 Notion 에 올리기"]';
  const DISCARD = 'button[aria-label="지난 동기화 때의 글로 되돌리기"]';
  const OPEN = 'button[aria-label="노트 열기"]';

  const remoteChanges = [
    { pageId: "3e813b18-d382-8127-a761-c5dc986d858a", type: "modified", path: "채소/감자.md" },
    { pageId: "3e913b18-0000-4000-8000-0000000071e0", type: "created", title: "Notion 새 페이지" },
    { pageId: "3e913b18-0000-4000-8000-00000000365e", type: "deleted", path: "과일/사과.md" },
  ];

  it("원격 변경은 내부 id 대신 노트 이름 · 폴더, 새 페이지는 Notion 제목으로 보인다", () => {
    m = renderComponent(SyncDashboard, baseProps({ remoteChanges }));
    const names = [...m.target.querySelectorAll(".im-sync-file-name")].map(normText);
    const folders = [...m.target.querySelectorAll(".im-sync-file-path")].map(normText);

    expect(names).toEqual(["감자", "Notion 새 페이지", "사과"]);
    expect(folders).toEqual(["채소", "새 페이지", "과일"]);
    expect(m.target.innerHTML).not.toContain("3e813b18");
  });

  it("받기는 볼트에 있는 노트에만 있고 그 노트만 받는다 — 지운 노트는 지운다고 말한다", () => {
    const props = baseProps({ remoteChanges });
    m = renderComponent(SyncDashboard, props);

    expect(m.target.querySelectorAll(PULL)).toHaveLength(1);
    expect(m.target.querySelectorAll(PULL_DELETION)).toHaveLength(1);
    m.target.querySelector<HTMLElement>(PULL)!.click();
    m.target.querySelector<HTMLElement>(PULL_DELETION)!.click();
    expect(props.onPullPath.mock.calls).toEqual([["채소/감자.md"], ["과일/사과.md"]]);
  });

  it("원격 항목을 누르면 그 노트의 줄 비교를 연다 — 아직 받지 않은 새 페이지는 견줄 글이 없어 열지 않는다", () => {
    const props = baseProps({ remoteChanges });
    m = renderComponent(SyncDashboard, props);
    const rows = m.target.querySelectorAll<HTMLElement>(".im-sync-file-item");

    rows[0]!.click();
    rows[1]!.click();
    rows[2]!.click();
    expect(props.onShowRemoteDiff.mock.calls).toEqual([[remoteChanges[0]], [remoteChanges[2]]]);
    // 반응 프록시가 아닌 평범한 사본이다 — 프록시는 복제하면 깨진다.
    expect(() => structuredClone(props.onShowRemoteDiff.mock.calls[0]![0])).not.toThrow();
    expect(props.onOpenFile).not.toHaveBeenCalled();
    expect(rows[1]!.classList.contains("im-sync-file-item-static")).toBe(true);
  });

  it("열기는 볼트의 그 노트를 연다 — 원격 항목도 볼트에 있는 노트만", () => {
    const props = baseProps({ remoteChanges });
    m = renderComponent(SyncDashboard, props);

    const opens = m.target.querySelectorAll<HTMLElement>(OPEN);
    expect(opens).toHaveLength(2);
    opens[0]!.click();
    expect(props.onOpenFile.mock.calls).toEqual([["채소/감자.md"]]);
    expect(props.onShowRemoteDiff).not.toHaveBeenCalled();
  });

  it("로컬 항목을 누르면 줄 비교를 연다 — 지운 노트도 무엇을 지웠는지 보이고, 열기는 볼트에 있는 노트에만 있다", () => {
    const localChanges = [
      { path: "a/고친.md", type: "modified", currentHash: "h2", previousHash: "h1" },
      { path: "지운.md", type: "deleted", currentHash: "", previousHash: "h3" },
    ];
    const props = baseProps({ localChanges });
    m = renderComponent(SyncDashboard, props);
    const rows = m.target.querySelectorAll<HTMLElement>(".im-sync-file-item");

    rows[0]!.click();
    rows[1]!.click();
    expect(props.onShowLocalDiff.mock.calls).toEqual([[localChanges[0]], [localChanges[1]]]);
    expect(() => structuredClone(props.onShowLocalDiff.mock.calls[0]![0])).not.toThrow();
    expect(props.onOpenFile).not.toHaveBeenCalled();

    const opens = m.target.querySelectorAll<HTMLElement>(OPEN);
    expect(opens).toHaveLength(1);
    opens[0]!.click();
    expect(props.onOpenFile.mock.calls).toEqual([["a/고친.md"]]);
  });

  it("동기화 중에는 올리기 · 받기 · 되돌리기를 누를 수 없다 — 노트 열기와 줄 비교는 보기만 해 된다", () => {
    const localChanges = [{ path: "노트.md", type: "modified" }];
    const props = baseProps({
      remoteChanges,
      localChanges,
      syncState: "syncing",
      operationType: "pull",
    });
    m = renderComponent(SyncDashboard, props);
    const actions = [...m.target.querySelectorAll<HTMLButtonElement>(".im-sync-file-action")];
    const opens = actions.filter((button) => button.matches(OPEN));
    const writes = actions.filter((button) => !button.matches(OPEN));

    expect(writes).toHaveLength(4);
    expect(writes.every((button) => button.disabled)).toBe(true);
    expect(opens).toHaveLength(3);
    expect(opens.every((button) => !button.disabled)).toBe(true);
    m.target.querySelector<HTMLElement>(".im-sync-file-item")!.click();
    expect(props.onShowLocalDiff).toHaveBeenCalledTimes(1);
  });

  it("올리기는 그 노트만 올린다 — 새 노트에는 되돌릴 원본이 없어 되돌리기가 없다", () => {
    const localChanges = [
      { path: "a/고친.md", type: "modified" },
      { path: "새.md", type: "created" },
    ];
    const props = baseProps({ localChanges });
    m = renderComponent(SyncDashboard, props);

    expect(m.target.querySelectorAll(PUSH)).toHaveLength(2);
    expect(m.target.querySelectorAll(DISCARD)).toHaveLength(1);
    m.target.querySelectorAll<HTMLElement>(PUSH)[1]!.click();
    expect(props.onPushPath).toHaveBeenCalledWith("새.md");
  });

  it("옮긴 폴더는 폴더 행으로, 옮긴 노트는 어디서 왔는지와 함께 보인다 — 올리기는 그 폴더를 올린다", () => {
    const localChanges = [{ path: "B/x.md", type: "moved", movedFrom: "A/x.md" }];
    const folderMoves = [{ from: "A", to: "B" }];
    const props = baseProps({ localChanges, folderMoves });
    m = renderComponent(SyncDashboard, props);

    const names = [...m.target.querySelectorAll(".im-sync-file-name")].map(normText);
    const where = [...m.target.querySelectorAll(".im-sync-file-path")].map(normText);
    expect(names).toEqual(["B/", "x"]);
    expect(where).toEqual(["← A", "← A/x"]);
    expect(normText(m.target.querySelector(".im-sync-badge"))).toBe("2");
    // 옮긴 노트는 되돌릴 수 없다(고침 · 지움만) — 올리기만 있다.
    expect(m.target.querySelectorAll(DISCARD)).toHaveLength(0);
    m.target
      .querySelector<HTMLElement>('button[aria-label="이 폴더의 이동을 Notion 에 올리기"]')!
      .click();
    expect(props.onPushPath).toHaveBeenCalledWith("B");
  });

  it("되돌리기는 한 번 누르면 그 변경을 넘긴다 — 되돌릴지는 받는 쪽의 확인 창이 묻는다", () => {
    const localChanges = [
      { path: "a/고친.md", type: "modified", currentHash: "h2", previousHash: "h1" },
      { path: "지운.md", type: "deleted", currentHash: "", previousHash: "h3" },
    ];
    const props = baseProps({ localChanges });
    m = renderComponent(SyncDashboard, props);
    const discards = m.target.querySelectorAll<HTMLElement>(DISCARD);

    discards[0]!.click();
    discards[1]!.click();
    m.flush();

    // 확인 창이 고친 노트인지 지운 노트인지를 말하도록 변경을 통째로 넘긴다.
    expect(props.onDiscard.mock.calls).toEqual([[localChanges[0]], [localChanges[1]]]);
    expect(() => structuredClone(props.onDiscard.mock.calls[0]![0])).not.toThrow();
    // 예전에는 처음 누르면 단추 글이 「되돌리기?」 로 바뀌고 한 번 더 눌러야 했다.
    expect([...m.target.querySelectorAll(DISCARD)].map(normText)).toEqual(["", ""]);
  });

  it("항목 동작은 글 없이 아이콘만 둔다 — 설명은 마우스를 올리면 뜨는 aria-label 이고 title 은 없다", () => {
    const props = baseProps({
      localChanges: [
        { path: "a/고친.md", type: "modified" },
        { path: "지운.md", type: "deleted" },
      ],
      folderMoves: [{ from: "A", to: "B" }],
      remoteChanges,
      conflictRecords: [{ id: "r1", obsidianPath: "배추.md" }],
      syncState: "conflict",
    });
    m = renderComponent(SyncDashboard, props);
    const buttons = [...m.target.querySelectorAll<HTMLElement>(".im-sync-file-action")];
    const iconOf = (button: Element) => button.querySelector("svg")?.getAttribute("class");

    expect(buttons.map((button) => [button.getAttribute("aria-label"), iconOf(button)])).toEqual([
      ["이 폴더의 이동을 Notion 에 올리기", "svg-icon lucide-upload"],
      ["노트 열기", "svg-icon lucide-go-to-file"],
      ["이 노트만 Notion 에 올리기", "svg-icon lucide-upload"],
      ["지난 동기화 때의 글로 되돌리기", "svg-icon lucide-undo"],
      ["이 노트만 Notion 에 올리기", "svg-icon lucide-upload"],
      ["지난 동기화 때의 글로 되돌리기", "svg-icon lucide-undo"],
      ["노트 열기", "svg-icon lucide-go-to-file"],
      ["이 노트만 Notion 에서 받기", "svg-icon lucide-download"],
      ["노트 열기", "svg-icon lucide-go-to-file"],
      ["Notion 에서 지운 대로 이 노트도 지우기", "svg-icon lucide-download"],
      ["노트 열기", "svg-icon lucide-go-to-file"],
    ]);
    for (const button of buttons) {
      expect(normText(button)).toBe("");
      expect(button.hasAttribute("title")).toBe(false);
      expect(button.classList.contains("clickable-icon")).toBe(true);
    }
    const refresh = m.target.querySelector(".im-sync-refresh-btn")!;
    expect([normText(refresh), iconOf(refresh), refresh.hasAttribute("title")]).toEqual([
      "",
      "svg-icon lucide-refresh-cw",
      false,
    ]);
  });

  it("충돌 중인 노트는 변경 · 원격 목록에 없고 충돌 칸에만 있다 — 거기서 노트를 열 수 있다", () => {
    const props = baseProps({
      syncState: "conflict",
      localChanges: [
        { path: "배추.md", type: "modified" },
        { path: "a/고친.md", type: "modified" },
      ],
      remoteChanges: [
        { pageId: "p1", type: "modified", path: "배추.md" },
        { pageId: "p2", type: "modified", path: "채소/감자.md" },
      ],
      conflictRecords: [{ id: "r1", obsidianPath: "배추.md" }],
    });
    m = renderComponent(SyncDashboard, props);
    const [changes, remote, conflicts] = [...m.target.querySelectorAll(".im-sync-section")];
    const names = (section: Element | undefined) =>
      [...section!.querySelectorAll(".im-sync-file-name")].map(normText);

    // 올리기는 충돌 노트를 건너뛰고 되돌리기는 거절한다 — 변경 목록에 두면 눌러도 소용이 없다.
    expect(names(changes)).toEqual(["고친"]);
    expect(names(remote)).toEqual(["감자"]);
    expect(names(conflicts)).toEqual(["배추"]);
    expect([...m.target.querySelectorAll(".im-sync-badge")].map(normText)).toEqual(["1", "1", "1"]);

    conflicts!.querySelector<HTMLElement>(OPEN)!.click();
    expect(props.onOpenFile.mock.calls).toEqual([["배추.md"]]);
  });

  it("충돌만 남았으면 「변경 사항 없음」 을 띄우지 않는다 — 충돌 칸이 할 일을 말한다", () => {
    m = renderComponent(
      SyncDashboard,
      baseProps({
        syncState: "conflict",
        localChanges: [{ path: "배추.md", type: "modified" }],
        conflictRecords: [{ id: "r1", obsidianPath: "배추.md" }],
      }),
    );

    expect(m.target.querySelector(".im-sync-empty")).toBeNull();
    expect(m.target.querySelectorAll(".im-sync-section")).toHaveLength(1);
    expect(m.target.querySelector(".im-sync-section-conflict")).not.toBeNull();
  });
});
