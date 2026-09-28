<script lang="ts">
  import { onMount } from "svelte";
  import { setIcon } from "obsidian";
  import type { LocalChange, FolderMoveChange, RemoteChange, SyncRecord } from "@im-nobsidian/core";

  interface SyncProgress {
    current: number;
    total: number;
    currentPath: string;
  }

  interface SyncStateUpdate {
    lastSyncAt: string | null;
    localChanges: LocalChange[];
    folderMoves?: FolderMoveChange[];
    remoteChanges?: RemoteChange[];
    conflictRecords: SyncRecord[];
    syncState: "ready" | "syncing" | "error" | "conflict";
    operationType: "pull" | "push" | "sync" | null;
    progress: SyncProgress | null;
    errorMessage: string | null;
    completionSummary: string | null;
  }

  interface Props {
    lastSyncAt: string | null;
    localChanges: LocalChange[];
    folderMoves?: FolderMoveChange[];
    remoteChanges: RemoteChange[];
    /** 충돌로 표시된 노트 — 상태 DB 의 충돌 기록. */
    conflictRecords: SyncRecord[];
    syncState: "ready" | "syncing" | "error" | "conflict";
    operationType: "pull" | "push" | "sync" | null;
    progress: SyncProgress | null;
    errorMessage: string | null;
    completionSummary: string | null;
    onReady: (updater: (state: SyncStateUpdate) => void) => void;
    onPull: () => void;
    onPush: () => void;
    onSync: () => void;
    onRefresh: () => void;
    onCancel: () => void;
    onOpenFile: (path: string) => void;
    onPushPath: (path: string) => void;
    /** 로컬 변경 하나를 되돌린다 — 되돌릴지는 받는 쪽(플러그인)이 확인 창으로 묻는다. */
    onDiscard: (change: LocalChange) => void;
    onPullPath: (path: string) => void;
    onShowLocalDiff: (change: LocalChange) => void;
    onShowRemoteDiff: (change: RemoteChange) => void;
    onResolveConflict: () => void;
  }

  let {
    lastSyncAt: initialLastSyncAt,
    localChanges: initialLocalChanges,
    folderMoves: initialFolderMoves = [],
    remoteChanges: initialRemoteChanges,
    conflictRecords: initialConflictRecords,
    syncState: initialSyncState,
    operationType: initialOperationType,
    progress: initialProgress,
    errorMessage: initialErrorMessage,
    completionSummary: initialCompletionSummary,
    onReady,
    onPull,
    onPush,
    onSync,
    onRefresh,
    onCancel,
    onOpenFile,
    onPushPath,
    onDiscard,
    onPullPath,
    onShowLocalDiff,
    onShowRemoteDiff,
    onResolveConflict,
  }: Props = $props();

  let lastSyncAt: string | null = $state(initialLastSyncAt);
  let localChanges: LocalChange[] = $state(initialLocalChanges);
  let folderMoves: FolderMoveChange[] = $state(initialFolderMoves);
  let remoteChanges: RemoteChange[] = $state(initialRemoteChanges);
  let conflictRecords: SyncRecord[] = $state(initialConflictRecords);
  let syncState: "ready" | "syncing" | "error" | "conflict" = $state(initialSyncState);
  let operationType: "pull" | "push" | "sync" | null = $state(initialOperationType);
  let progress: SyncProgress | null = $state(initialProgress);
  let errorMessage: string | null = $state(initialErrorMessage);
  let completionSummary: string | null = $state(initialCompletionSummary);
  let completionVisible = $state(false);
  let completionTimer: ReturnType<typeof setTimeout> | null = null;

  function applyUpdate(s: SyncStateUpdate) {
    lastSyncAt = s.lastSyncAt;
    localChanges = s.localChanges;
    if (s.folderMoves) folderMoves = s.folderMoves;
    if (s.remoteChanges) remoteChanges = s.remoteChanges;
    conflictRecords = s.conflictRecords;
    syncState = s.syncState;
    operationType = s.operationType ?? null;
    progress = s.progress;
    errorMessage = s.errorMessage;

    if (s.completionSummary && s.completionSummary !== completionSummary) {
      completionSummary = s.completionSummary;
      completionVisible = true;
      if (completionTimer) clearTimeout(completionTimer);
      completionTimer = setTimeout(() => {
        completionVisible = false;
        completionTimer = null;
      }, 5000);
    } else if (s.completionSummary === null) {
      completionSummary = null;
      completionVisible = false;
    }
  }

  onMount(() => {
    onReady(applyUpdate);
    return () => {
      if (completionTimer) clearTimeout(completionTimer);
    };
  });

  const isSyncing = $derived(syncState === "syncing");

  const operationLabel = $derived(
    operationType === "pull" ? "Pull"
    : operationType === "push" ? "Push"
    : operationType === "sync" ? "Sync"
    : "동기화"
  );

  const progressPercent = $derived(
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0
  );

  const changesByType = $derived({
    created: localChanges.filter((c) => c.type === "created"),
    modified: localChanges.filter((c) => c.type === "modified"),
    deleted: localChanges.filter((c) => c.type === "deleted"),
    moved: localChanges.filter((c) => c.type === "moved"),
  });

  /**
   * 충돌 중인 노트는 충돌 칸에서만 다룬다(VS Code 의 「병합 변경」 처럼) — 변경 목록에 두면 올리기는 그 노트를
   * 건너뛰어 눌러도 아무 일이 없고, 되돌리기는 거절된다. 원격 목록의 받기도 충돌을 풀지 않는다.
   */
  const conflictPaths = $derived(new Set(conflictRecords.map((record) => record.obsidianPath)));
  const shownLocalChanges = $derived(
    localChanges.filter((change) => !conflictPaths.has(change.path)),
  );
  const shownRemoteChanges = $derived(
    remoteChanges.filter((change) => !change.path || !conflictPaths.has(change.path)),
  );

  const totalChanges = $derived(shownLocalChanges.length + folderMoves.length);
  const totalRemoteChanges = $derived(shownRemoteChanges.length);

  const remoteChangesByType = $derived({
    created: remoteChanges.filter((c) => c.type === "created"),
    modified: remoteChanges.filter((c) => c.type === "modified"),
    deleted: remoteChanges.filter((c) => c.type === "deleted"),
    moved: remoteChanges.filter((c) => c.type === "moved"),
  });

  const statusIcon = $derived(
    syncState === "syncing"
      ? "⟳"
      : syncState === "error"
        ? "✕"
        : syncState === "conflict"
          ? "⚠"
          : "✓",
  );

  const statusLabel = $derived(
    syncState === "syncing"
      ? `${operationLabel} 중...`
      : syncState === "error"
        ? "오류 발생"
        : syncState === "conflict"
          ? `충돌 ${conflictRecords.length}건`
          : "준비됨",
  );

  function formatTime(iso: string | null): string {
    if (!iso) return "아직 동기화 안됨";
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return "방금 전";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}시간 전`;
    return d.toLocaleDateString("ko-KR", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function typeIcon(type: string): string {
    switch (type) {
      case "created":
        return "A";
      case "modified":
        return "M";
      case "deleted":
        return "D";
      case "moved":
        return "R";
      default:
        return "?";
    }
  }

  function typeClass(type: string): string {
    switch (type) {
      case "created":
        return "im-sync-change-added";
      case "modified":
        return "im-sync-change-modified";
      case "deleted":
        return "im-sync-change-deleted";
      case "moved":
        return "im-sync-change-moved";
      default:
        return "";
    }
  }

  function fileName(path: string): string {
    return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
  }

  function folderOf(path: string): string {
    return path.substring(0, path.lastIndexOf("/"));
  }

  /** 옮긴 노트는 어디서 왔는지를 보인다 — 새 이름만 보이면 새 노트와 구분되지 않는다. */
  function localWhere(change: LocalChange): string {
    return change.type === "moved" && change.movedFrom
      ? `← ${change.movedFrom.replace(/\.md$/, "")}`
      : folderOf(change.path);
  }

  /** 원격 변경의 이름 — 볼트에 있는 노트는 노트 이름, 아직 없는 새 페이지는 Notion 제목. */
  function remoteName(change: RemoteChange): string {
    if (change.path) return fileName(change.path);
    return change.title ?? "Notion 페이지";
  }

  function remotePullLabel(change: RemoteChange): string {
    return change.type === "deleted"
      ? "Notion 에서 지운 대로 이 노트도 지우기"
      : "이 노트만 Notion 에서 받기";
  }

  /*
   * 항목을 누르면 줄 비교 창을 연다(Obsidian Git 처럼) — 노트는 열기 단추로 연다. 컴포넌트 밖(core)으로 나가는
   * 값이라 반응 프록시가 아닌 평범한 사본을 넘긴다 — 프록시는 복제(structuredClone)하면 깨진다.
   */
  function showLocalDiff(change: LocalChange): void {
    onShowLocalDiff($state.snapshot(change));
  }

  /** 아직 받지 않은 새 페이지는 견줄 지난 글이 없다 — 받은 뒤에 견준다. */
  function showRemoteDiff(change: RemoteChange): void {
    if (change.path) onShowRemoteDiff($state.snapshot(change));
  }

  function discard(change: LocalChange): void {
    onDiscard($state.snapshot(change));
  }

  /** 단추의 아이콘 — 열기 · 되돌리기는 Obsidian Git 의 파일 단추, 올리기 · 받기는 그 Push · Pull 과 같은 것이다. */
  const ICON = {
    open: "go-to-file",
    push: "upload",
    pull: "download",
    discard: "undo",
    refresh: "refresh-cw",
  } as const;

  /**
   * 단추에 Obsidian 아이콘을 넣는다 — 글 없이 아이콘만 두고, 무엇을 하는지는 `aria-label` 이 마우스를 올렸을
   * 때 Obsidian 툴팁으로 보인다. `title` 은 두지 않는다 — 브라우저 툴팁이 한 번 더 뜬다.
   */
  function icon(node: HTMLElement, name: string): void {
    setIcon(node, name);
  }

  let changesExpanded = $state(true);
  let remoteExpanded = $state(true);
  let conflictsExpanded = $state(true);
</script>

<!-- 항목 동작 — 아이콘만 두고 설명은 aria-label(툴팁)로. 쓰는 동작은 동기화 중에 막는다. -->
{#snippet action(name: string, label: string, run: () => void, disabled: boolean)}
  <button
    class="im-sync-file-action clickable-icon"
    aria-label={label}
    {disabled}
    onclick={run}
    type="button"
    use:icon={name}
  ></button>
{/snippet}

<div class="im-sync-dashboard">
  <!-- Status Header -->
  <div class="im-sync-header">
    <div class="im-sync-status" data-state={syncState}>
      <span class="im-sync-status-icon" class:im-sync-spinning={isSyncing}>{statusIcon}</span>
      <span class="im-sync-status-label">{statusLabel}</span>
    </div>
    <button
      class="im-sync-refresh-btn clickable-icon"
      onclick={onRefresh}
      disabled={isSyncing}
      aria-label="새로고침"
      type="button"
      use:icon={ICON.refresh}
    ></button>
  </div>

  <!-- Last Sync Time -->
  <div class="im-sync-meta">
    <span class="im-sync-meta-label">마지막 동기화</span>
    <span class="im-sync-meta-value">{formatTime(lastSyncAt)}</span>
  </div>

  <!-- Error Message -->
  {#if errorMessage}
    <div class="im-sync-error">{errorMessage}</div>
  {/if}

  <!-- Progress Bar -->
  {#if progress}
    <div class="im-sync-progress">
      <div class="im-sync-progress-header">
        <span class="im-sync-progress-label">{operationLabel} 진행 중</span>
        <span class="im-sync-progress-pct">{progressPercent}%</span>
      </div>
      <div class="im-sync-progress-bar">
        <div
          class="im-sync-progress-fill"
          style="width: {progressPercent}%"
        ></div>
      </div>
      <div class="im-sync-progress-footer">
        <span class="im-sync-progress-text">
          {progress.current}/{progress.total}
          {#if progress.currentPath}
            — {fileName(progress.currentPath)}
          {/if}
        </span>
        <button class="im-sync-cancel-btn" onclick={onCancel} type="button">
          취소
        </button>
      </div>
    </div>
  {/if}

  <!-- Completion Summary -->
  {#if completionVisible && completionSummary}
    <div class="im-sync-completion">
      <span class="im-sync-completion-icon">✓</span>
      <span class="im-sync-completion-text">{completionSummary}</span>
    </div>
  {/if}

  <!-- Action Buttons -->
  <div class="im-sync-actions">
    <button class="im-sync-btn im-sync-btn-pull" onclick={onPull} disabled={isSyncing}>
      ↓ Pull
    </button>
    <button class="im-sync-btn im-sync-btn-push" onclick={onPush} disabled={isSyncing}>
      ↑ Push
    </button>
    <button class="im-sync-btn im-sync-btn-sync" onclick={onSync} disabled={isSyncing}>
      ⇅ Sync
    </button>
  </div>

  <!-- Changes Section -->
  {#if totalChanges > 0}
    <div class="im-sync-section">
      <button
        class="im-sync-section-header"
        onclick={() => (changesExpanded = !changesExpanded)}
        type="button"
      >
        <span class="im-sync-section-chevron" class:im-sync-expanded={changesExpanded}>›</span>
        <span>변경된 파일</span>
        <span class="im-sync-badge">{totalChanges}</span>
      </button>
      {#if changesExpanded}
        <div class="im-sync-file-list">
          {#each folderMoves as move (move.to)}
            <div class="im-sync-file-row">
              <div class="im-sync-file-item" title="{move.from} → {move.to}">
                <span class="im-sync-file-type {typeClass('moved')}">{typeIcon("moved")}</span>
                <span class="im-sync-file-name">{fileName(move.to)}/</span>
                <span class="im-sync-file-path">← {move.from}</span>
              </div>
              <span class="im-sync-file-actions">
                {@render action(
                  ICON.push,
                  "이 폴더의 이동을 Notion 에 올리기",
                  () => onPushPath(move.to),
                  isSyncing,
                )}
              </span>
            </div>
          {/each}
          {#each shownLocalChanges as change (change.path)}
            <div class="im-sync-file-row">
              <button
                class="im-sync-file-item"
                onclick={() => showLocalDiff(change)}
                type="button"
              >
                <span class="im-sync-file-type {typeClass(change.type)}"
                  >{typeIcon(change.type)}</span
                >
                <span class="im-sync-file-name" title={change.path}>{fileName(change.path)}</span>
                <span
                  class="im-sync-file-path"
                  title={change.movedFrom ? `${change.movedFrom} → ${change.path}` : change.path}
                  >{localWhere(change)}</span
                >
              </button>
              <span class="im-sync-file-actions">
                {#if change.type !== "deleted"}
                  {@render action(ICON.open, "노트 열기", () => onOpenFile(change.path), false)}
                {/if}
                {@render action(
                  ICON.push,
                  "이 노트만 Notion 에 올리기",
                  () => onPushPath(change.path),
                  isSyncing,
                )}
                {#if change.type === "modified" || change.type === "deleted"}
                  {@render action(
                    ICON.discard,
                    "지난 동기화 때의 글로 되돌리기",
                    () => discard(change),
                    isSyncing,
                  )}
                {/if}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else if syncState !== "syncing" && conflictRecords.length === 0}
    <div class="im-sync-empty">변경 사항 없음</div>
  {/if}

  <!-- Remote Changes Section -->
  {#if totalRemoteChanges > 0}
    <div class="im-sync-section">
      <button
        class="im-sync-section-header"
        onclick={() => (remoteExpanded = !remoteExpanded)}
        type="button"
      >
        <span class="im-sync-section-chevron" class:im-sync-expanded={remoteExpanded}>›</span>
        <span>원격 변경 (Notion)</span>
        <span class="im-sync-badge im-sync-badge-remote">{totalRemoteChanges}</span>
      </button>
      {#if remoteExpanded}
        <div class="im-sync-file-list">
          {#each shownRemoteChanges as change (change.pageId)}
            <div class="im-sync-file-row">
              <button
                class="im-sync-file-item"
                class:im-sync-file-item-static={!change.path}
                title={change.path ? undefined : "아직 받지 않은 새 페이지 — 받은 뒤에 견줄 수 있습니다"}
                onclick={() => showRemoteDiff(change)}
                type="button"
              >
                <span class="im-sync-file-type {typeClass(change.type)}"
                  >{typeIcon(change.type)}</span
                >
                <span class="im-sync-file-name" title={change.path ?? change.title}
                  >{remoteName(change)}</span
                >
                <span class="im-sync-file-path" title={change.path}
                  >{change.path
                    ? folderOf(change.path)
                    : change.type === "created"
                      ? "새 페이지"
                      : ""}</span
                >
              </button>
              {#if change.path}
                {@const path = change.path}
                <span class="im-sync-file-actions">
                  {@render action(ICON.open, "노트 열기", () => onOpenFile(path), false)}
                  {@render action(
                    ICON.pull,
                    remotePullLabel(change),
                    () => onPullPath(path),
                    isSyncing,
                  )}
                </span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Conflicts Section -->
  {#if conflictRecords.length > 0}
    <div class="im-sync-section im-sync-section-conflict">
      <button
        class="im-sync-section-header"
        onclick={() => (conflictsExpanded = !conflictsExpanded)}
        type="button"
      >
        <span class="im-sync-section-chevron" class:im-sync-expanded={conflictsExpanded}>›</span>
        <span>충돌</span>
        <span class="im-sync-badge im-sync-badge-warn">{conflictRecords.length}</span>
      </button>
      {#if conflictsExpanded}
        <div class="im-sync-file-list">
          {#each conflictRecords as record (record.id)}
            <div class="im-sync-file-row">
              <div class="im-sync-file-item im-sync-conflict-item">
                <span class="im-sync-file-type im-sync-change-conflict">C</span>
                <span class="im-sync-file-name" title={record.obsidianPath}
                  >{fileName(record.obsidianPath)}</span
                >
              </div>
              <span class="im-sync-file-actions">
                {@render action(ICON.open, "노트 열기", () => onOpenFile(record.obsidianPath), false)}
              </span>
            </div>
          {/each}
        </div>
        <button class="im-sync-resolve-btn" onclick={onResolveConflict} type="button">
          충돌 해결
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .im-sync-dashboard {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0;
    height: 100%;
    font-size: var(--font-ui-small);
  }

  /* Header */
  .im-sync-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--background-modifier-border);
  }
  .im-sync-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .im-sync-status[data-state="ready"] {
    color: var(--text-success);
  }
  .im-sync-status[data-state="syncing"] {
    color: var(--text-accent);
  }
  .im-sync-status[data-state="error"] {
    color: var(--text-error);
  }
  .im-sync-status[data-state="conflict"] {
    color: var(--text-warning);
  }
  .im-sync-status-icon {
    font-size: 16px;
    display: inline-block;
  }
  .im-sync-spinning {
    animation: im-spin 1s linear infinite;
  }
  @keyframes im-spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
  /* 아이콘 단추(새로고침 · 항목 동작) — Obsidian 의 clickable-icon 에 아이콘만 둔다. */
  .im-sync-refresh-btn,
  .im-sync-file-action {
    cursor: pointer;
  }
  .im-sync-refresh-btn:disabled,
  .im-sync-file-action:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Meta */
  .im-sync-meta {
    display: flex;
    justify-content: space-between;
    padding: 6px 12px;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  /*
   * Error — 옅은 빨강 바탕(main.css 의 `--im-nobsidian-tint`)에 보통 글색. 오류 바탕 변수는 테마에서 오류
   * 글색과 같은 색일 수 있어, 예전처럼 함께 쓰면 실패 이유가 바탕에 묻혀 읽히지 않았다(1.13 기본 테마).
   */
  .im-sync-error {
    margin: 4px 12px;
    padding: 6px 10px;
    background: rgba(var(--color-red-rgb), var(--im-nobsidian-tint));
    border-left: 3px solid var(--text-error);
    color: var(--text-normal);
    border-radius: 4px;
    font-size: var(--font-ui-smaller);
  }

  /* Progress */
  .im-sync-progress {
    padding: 8px 12px;
    background: var(--background-secondary);
    border-bottom: 1px solid var(--background-modifier-border);
  }
  .im-sync-progress-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }
  .im-sync-progress-label {
    font-size: var(--font-ui-smaller);
    font-weight: 600;
    color: var(--text-accent);
  }
  .im-sync-progress-pct {
    font-size: var(--font-ui-smaller);
    font-weight: 600;
    color: var(--text-accent);
  }
  .im-sync-progress-bar {
    height: 6px;
    background: var(--background-modifier-border);
    border-radius: 3px;
    overflow: hidden;
  }
  .im-sync-progress-fill {
    height: 100%;
    background: var(--interactive-accent);
    transition: width 0.2s ease;
    border-radius: 3px;
  }
  .im-sync-progress-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 4px;
  }
  .im-sync-progress-text {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .im-sync-cancel-btn {
    all: unset;
    cursor: pointer;
    font-size: var(--font-ui-smaller);
    color: var(--text-error);
    padding: 2px 8px;
    border-radius: 4px;
    flex-shrink: 0;
    margin-left: 8px;
  }
  .im-sync-cancel-btn:hover {
    background: rgba(var(--color-red-rgb), var(--im-nobsidian-tint));
  }

  /* Completion Summary */
  .im-sync-completion {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: var(--background-secondary);
    border-bottom: 1px solid var(--background-modifier-border);
    animation: im-fade-in 0.3s ease;
  }
  .im-sync-completion-icon {
    color: var(--text-success);
    font-weight: 700;
    flex-shrink: 0;
  }
  .im-sync-completion-text {
    font-size: var(--font-ui-smaller);
    color: var(--text-success);
    font-weight: 500;
  }
  @keyframes im-fade-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Action Buttons */
  .im-sync-actions {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--background-modifier-border);
  }
  .im-sync-btn {
    all: unset;
    cursor: pointer;
    text-align: center;
    padding: 6px 0;
    border-radius: 4px;
    font-size: var(--font-ui-small);
    font-weight: 500;
    background: var(--interactive-normal);
    color: var(--text-normal);
    border: 1px solid var(--background-modifier-border);
  }
  .im-sync-btn:hover:not(:disabled) {
    background: var(--interactive-hover);
  }
  .im-sync-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .im-sync-btn-sync {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-color: var(--interactive-accent);
  }
  .im-sync-btn-sync:hover:not(:disabled) {
    background: var(--interactive-accent-hover);
  }

  /* Sections */
  .im-sync-section {
    border-bottom: 1px solid var(--background-modifier-border);
  }
  .im-sync-section-header {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 8px 12px;
    font-weight: 600;
    font-size: var(--font-ui-small);
    box-sizing: border-box;
  }
  .im-sync-section-header:hover {
    background: var(--background-modifier-hover);
  }
  .im-sync-section-chevron {
    display: inline-block;
    transition: transform 0.15s ease;
    font-size: 12px;
    width: 12px;
    text-align: center;
  }
  .im-sync-expanded {
    transform: rotate(90deg);
  }

  /* Badges */
  .im-sync-badge {
    margin-left: auto;
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    padding: 1px 6px;
    border-radius: 10px;
    font-size: var(--font-ui-smaller);
    font-weight: 500;
  }
  .im-sync-badge-warn {
    background: rgba(var(--color-red-rgb), var(--im-nobsidian-tint));
    color: var(--text-error);
  }
  .im-sync-badge-remote {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  /* File List */
  .im-sync-file-list {
    padding: 0 4px 4px;
  }
  .im-sync-file-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-radius: 4px;
    width: 100%;
    box-sizing: border-box;
    overflow: hidden;
  }
  .im-sync-file-item:hover {
    background: var(--background-modifier-hover);
  }
  .im-sync-file-item-static {
    cursor: default;
  }
  .im-sync-file-type {
    font-family: var(--font-monospace);
    font-size: 11px;
    font-weight: 700;
    width: 14px;
    text-align: center;
    flex-shrink: 0;
  }
  .im-sync-change-added {
    color: var(--text-success);
  }
  .im-sync-change-modified {
    color: var(--text-accent);
  }
  .im-sync-change-deleted {
    color: var(--text-error);
  }
  .im-sync-change-moved {
    color: var(--text-warning);
  }
  .im-sync-change-conflict {
    color: var(--text-warning);
  }
  .im-sync-file-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .im-sync-file-path {
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40%;
    flex-shrink: 0;
  }

  /* Empty State */
  .im-sync-empty {
    padding: 16px 12px;
    text-align: center;
    color: var(--text-muted);
  }

  /* Resolve Button */
  .im-sync-resolve-btn {
    all: unset;
    cursor: pointer;
    display: block;
    margin: 4px 12px 8px;
    padding: 4px 12px;
    text-align: center;
    font-size: var(--font-ui-smaller);
    color: var(--text-warning);
    border: 1px solid var(--text-warning);
    border-radius: 4px;
  }
  .im-sync-resolve-btn:hover {
    background: var(--background-modifier-hover);
  }
  .im-sync-file-row {
    display: flex;
    align-items: center;
  }
  .im-sync-file-row > .im-sync-file-item {
    flex: 1;
    min-width: 0;
  }
  .im-sync-file-actions {
    display: flex;
    gap: 2px;
    opacity: 0;
  }
  .im-sync-file-row:hover .im-sync-file-actions,
  .im-sync-file-row:focus-within .im-sync-file-actions {
    opacity: 1;
  }
  .im-sync-file-action {
    --icon-size: var(--icon-s);
    padding: var(--size-2-1) var(--size-2-2);
  }
</style>
