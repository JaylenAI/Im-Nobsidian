<script lang="ts">
  import type { LocalChange, Conflict } from "@im-nobsidian/core";

  interface SyncProgress {
    current: number;
    total: number;
    currentPath: string;
  }

  interface Props {
    lastSyncAt: string | null;
    localChanges: LocalChange[];
    conflicts: Conflict[];
    syncState: "ready" | "syncing" | "error" | "conflict";
    progress: SyncProgress | null;
    errorMessage: string | null;
    onPull: () => void;
    onPush: () => void;
    onSync: () => void;
    onRefresh: () => void;
    onOpenFile: (path: string) => void;
    onResolveConflict: () => void;
  }

  let {
    lastSyncAt,
    localChanges,
    conflicts,
    syncState,
    progress,
    errorMessage,
    onPull,
    onPush,
    onSync,
    onRefresh,
    onOpenFile,
    onResolveConflict,
  }: Props = $props();

  const isSyncing = $derived(syncState === "syncing");

  const changesByType = $derived({
    created: localChanges.filter((c) => c.type === "created"),
    modified: localChanges.filter((c) => c.type === "modified"),
    deleted: localChanges.filter((c) => c.type === "deleted"),
    moved: localChanges.filter((c) => c.type === "moved"),
  });

  const totalChanges = $derived(localChanges.length);

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
      ? "동기화 중..."
      : syncState === "error"
        ? "오류 발생"
        : syncState === "conflict"
          ? `충돌 ${conflicts.length}건`
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

  let changesExpanded = $state(true);
  let conflictsExpanded = $state(true);
</script>

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
    >
      ↻
    </button>
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
      <div class="im-sync-progress-bar">
        <div
          class="im-sync-progress-fill"
          style="width: {progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%"
        ></div>
      </div>
      <span class="im-sync-progress-text">
        {progress.current}/{progress.total}
        {#if progress.currentPath}
          — {fileName(progress.currentPath)}
        {/if}
      </span>
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
          {#each localChanges as change (change.path)}
            <button
              class="im-sync-file-item"
              onclick={() => change.type !== "deleted" && onOpenFile(change.path)}
              type="button"
            >
              <span class="im-sync-file-type {typeClass(change.type)}">{typeIcon(change.type)}</span
              >
              <span class="im-sync-file-name" title={change.path}>{fileName(change.path)}</span>
              <span class="im-sync-file-path" title={change.path}
                >{change.path.substring(0, change.path.lastIndexOf("/"))}</span
              >
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else if syncState !== "syncing"}
    <div class="im-sync-empty">변경 사항 없음</div>
  {/if}

  <!-- Conflicts Section -->
  {#if conflicts.length > 0}
    <div class="im-sync-section im-sync-section-conflict">
      <button
        class="im-sync-section-header"
        onclick={() => (conflictsExpanded = !conflictsExpanded)}
        type="button"
      >
        <span class="im-sync-section-chevron" class:im-sync-expanded={conflictsExpanded}>›</span>
        <span>충돌</span>
        <span class="im-sync-badge im-sync-badge-warn">{conflicts.length}</span>
      </button>
      {#if conflictsExpanded}
        <div class="im-sync-file-list">
          {#each conflicts as conflict (conflict.syncRecord.id)}
            <div class="im-sync-file-item im-sync-conflict-item">
              <span class="im-sync-file-type im-sync-change-conflict">C</span>
              <span class="im-sync-file-name" title={conflict.localChange.path}
                >{fileName(conflict.localChange.path)}</span
              >
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
  .im-sync-refresh-btn {
    font-size: 16px;
    cursor: pointer;
  }

  /* Meta */
  .im-sync-meta {
    display: flex;
    justify-content: space-between;
    padding: 6px 12px;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  /* Error */
  .im-sync-error {
    margin: 4px 12px;
    padding: 6px 10px;
    background: var(--background-modifier-error);
    color: var(--text-error);
    border-radius: 4px;
    font-size: var(--font-ui-smaller);
  }

  /* Progress */
  .im-sync-progress {
    padding: 6px 12px;
  }
  .im-sync-progress-bar {
    height: 4px;
    background: var(--background-modifier-border);
    border-radius: 2px;
    overflow: hidden;
  }
  .im-sync-progress-fill {
    height: 100%;
    background: var(--interactive-accent);
    transition: width 0.3s ease;
    border-radius: 2px;
  }
  .im-sync-progress-text {
    display: block;
    margin-top: 4px;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
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
    background: var(--background-modifier-error);
    color: var(--text-error);
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
</style>
