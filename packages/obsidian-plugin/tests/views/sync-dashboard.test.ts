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
  conflicts: unknown[];
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
    conflicts: [],
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
    onDiscardPath: vi.fn(),
    onPullPath: vi.fn(),
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

  it("conflict 상태: 충돌 건수 라벨 + 충돌 파일 목록 렌더", () => {
    const conflicts = [
      { syncRecord: { id: "r1" }, localChange: { path: "채소/감자.md" } },
      { syncRecord: { id: "r2" }, localChange: { path: "채소/당근.md" } },
    ];
    m = renderComponent(SyncDashboard, baseProps({ syncState: "conflict", conflicts }));
    expect(normText(m.target.querySelector(".im-sync-status-label"))).toBe("충돌 2건");
    const items = m.target.querySelectorAll(".im-sync-conflict-item");
    expect(items).toHaveLength(2);
    expect(normText(m.target)).toContain("감자");
    expect(normText(m.target)).toContain("당근");
  });

  it("onReady 업데이터로 완료 요약을 동적 갱신하면 완료 배너가 보인다", () => {
    m = renderComponent(SyncDashboard, baseProps());
    expect(m.target.querySelector(".im-sync-completion")).toBeNull();
    expect(updater).not.toBeNull();

    updater!({
      lastSyncAt: "2026-05-30T00:00:00.000Z",
      localChanges: [],
      remoteChanges: [],
      conflicts: [],
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

  it("↓ 는 볼트에 있는 노트에만 있고 그 노트만 받는다 — 지운 노트는 지운다고 말한다", () => {
    const props = baseProps({ remoteChanges });
    m = renderComponent(SyncDashboard, props);

    expect(m.target.querySelectorAll(PULL)).toHaveLength(1);
    expect(m.target.querySelectorAll(PULL_DELETION)).toHaveLength(1);
    m.target.querySelector<HTMLElement>(PULL)!.click();
    m.target.querySelector<HTMLElement>(PULL_DELETION)!.click();
    expect(props.onPullPath.mock.calls).toEqual([["채소/감자.md"], ["과일/사과.md"]]);
  });

  it("원격 항목을 누르면 볼트의 그 노트를 연다 — 아직 없는 새 페이지는 열지 않는다", () => {
    const props = baseProps({ remoteChanges });
    m = renderComponent(SyncDashboard, props);
    const rows = m.target.querySelectorAll<HTMLElement>(".im-sync-file-item");

    rows[0]!.click();
    rows[1]!.click();
    expect(props.onOpenFile.mock.calls).toEqual([["채소/감자.md"]]);
  });

  it("동기화 중에는 항목 동작을 누를 수 없다", () => {
    const localChanges = [{ path: "노트.md", type: "modified" }];
    m = renderComponent(
      SyncDashboard,
      baseProps({ remoteChanges, localChanges, syncState: "syncing", operationType: "pull" }),
    );
    const actions = [...m.target.querySelectorAll<HTMLButtonElement>(".im-sync-file-action")];
    expect(actions).toHaveLength(4);
    expect(actions.every((button) => button.disabled)).toBe(true);
  });

  it("↑ 는 그 노트만 올린다 — 새 노트에는 되돌릴 원본이 없어 ↺ 가 없다", () => {
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

  it("옮긴 폴더는 폴더 행으로, 옮긴 노트는 어디서 왔는지와 함께 보인다 — ↑ 는 그 폴더를 올린다", () => {
    const localChanges = [{ path: "B/x.md", type: "moved", movedFrom: "A/x.md" }];
    const folderMoves = [{ from: "A", to: "B" }];
    const props = baseProps({ localChanges, folderMoves });
    m = renderComponent(SyncDashboard, props);

    const names = [...m.target.querySelectorAll(".im-sync-file-name")].map(normText);
    const where = [...m.target.querySelectorAll(".im-sync-file-path")].map(normText);
    expect(names).toEqual(["B/", "x"]);
    expect(where).toEqual(["← A", "← A/x"]);
    expect(normText(m.target.querySelector(".im-sync-badge"))).toBe("2");
    // 옮긴 노트는 되돌릴 수 없다(고침 · 지움만) — ↑ 만 있다.
    expect(m.target.querySelectorAll(DISCARD)).toHaveLength(0);
    m.target
      .querySelector<HTMLElement>('button[aria-label="이 폴더의 이동을 Notion 에 올리기"]')!
      .click();
    expect(props.onPushPath).toHaveBeenCalledWith("B");
  });

  it("↺ 는 두 번 눌러야 되돌리고, 3초 안에 다시 누르지 않으면 풀린다", () => {
    vi.useFakeTimers();
    try {
      const props = baseProps({ localChanges: [{ path: "a/고친.md", type: "modified" }] });
      m = renderComponent(SyncDashboard, props);
      const discard = () => m!.target.querySelector<HTMLElement>(DISCARD)!;

      discard().click();
      m.flush();
      expect(props.onDiscardPath).not.toHaveBeenCalled();
      expect(normText(discard())).toBe("되돌리기?");

      vi.advanceTimersByTime(3000);
      m.flush();
      expect(normText(discard())).toBe("↺");

      discard().click();
      m.flush();
      discard().click();
      m.flush();
      expect(props.onDiscardPath.mock.calls).toEqual([["a/고친.md"]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
