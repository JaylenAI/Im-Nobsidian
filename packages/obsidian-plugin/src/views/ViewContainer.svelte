<script lang="ts">
  import type { ViewRenderData, DBEntry } from "@im-nobsidian/core";
  import type { ViewConfig } from "@im-nobsidian/core";
  import GalleryView from "./GalleryView.svelte";
  import BoardView from "./BoardView.svelte";
  import TableView from "./TableView.svelte";
  import CalendarView from "./CalendarView.svelte";

  interface Props {
    data: ViewRenderData;
    availableViews: ViewConfig[];
    onViewChange?: (viewId: string) => void;
    onEntryClick?: (entry: DBEntry) => void;
    onEntryMove?: (entry: DBEntry, newGroup: string) => void;
    onDateClick?: (date: string) => void;
  }

  let {
    data,
    availableViews,
    onViewChange,
    onEntryClick,
    onEntryMove,
    onDateClick,
  }: Props = $props();

  const viewType = $derived(data.viewConfig.type);
  const activeViewId = $derived(data.viewConfig.id);

  const viewIcons: Record<string, string> = {
    gallery: "🖼",
    board: "📋",
    table: "📊",
    calendar: "📅",
    list: "📝",
    timeline: "📏",
  };
</script>

<div class="im-view-container">
  <div class="im-view-header">
    {#if data.databaseName}
      <span class="im-view-db-name">{data.databaseName}</span>
    {/if}
    <div class="im-view-tabs">
      {#each availableViews as view (view.id)}
        <button
          class="im-view-tab"
          class:im-view-tab-active={view.id === activeViewId}
          onclick={() => onViewChange?.(view.id)}
          type="button"
        >
          <span class="im-view-tab-icon">{viewIcons[view.type] ?? "📄"}</span>
          {view.name}
        </button>
      {/each}
    </div>
  </div>

  <div class="im-view-body">
    {#if viewType === "gallery"}
      <GalleryView {data} {onEntryClick} />
    {:else if viewType === "board"}
      <BoardView {data} {onEntryClick} {onEntryMove} />
    {:else if viewType === "table"}
      <TableView {data} {onEntryClick} />
    {:else if viewType === "calendar"}
      <CalendarView {data} {onEntryClick} {onDateClick} />
    {:else}
      <div class="im-view-unsupported">
        <p>'{viewType}' 뷰 타입은 아직 지원하지 않습니다.</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .im-view-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--background-primary);
  }
  .im-view-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--background-modifier-border);
  }
  .im-view-db-name {
    font-weight: 600;
    font-size: 15px;
    margin-right: auto;
  }
  .im-view-tabs {
    display: flex;
    gap: 2px;
  }
  .im-view-tab {
    all: unset;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 13px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .im-view-tab:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }
  .im-view-tab-active {
    background: var(--background-modifier-active-hover);
    color: var(--text-normal);
    font-weight: 500;
  }
  .im-view-tab-icon {
    font-size: 14px;
  }
  .im-view-body {
    flex: 1;
    overflow: auto;
  }
  .im-view-unsupported {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
  }
</style>
