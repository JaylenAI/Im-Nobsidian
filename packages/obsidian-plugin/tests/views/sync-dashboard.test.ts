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
