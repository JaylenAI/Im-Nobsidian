<script lang="ts">
  import type { ViewRenderData, DBEntry, GroupedEntries } from "@im-nobsidian/core";
  import IconDisplay from "./components/IconDisplay.svelte";
  import PropertyBadge from "./components/PropertyBadge.svelte";

  interface Props {
    data: ViewRenderData;
    onEntryClick?: (entry: DBEntry) => void;
    onEntryMove?: (entry: DBEntry, newGroup: string) => void;
  }

  let { data, onEntryClick, onEntryMove }: Props = $props();

  const groups = $derived(data.grouped ?? []);

  let dragEntry: DBEntry | null = $state(null);
  let dragOverGroup: string | null = $state(null);

  function handleDragStart(e: DragEvent, entry: DBEntry) {
    dragEntry = entry;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", entry.path);
    }
  }

  function handleDragOver(e: DragEvent, groupName: string) {
    e.preventDefault();
    dragOverGroup = groupName;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }

  function handleDragLeave() {
    dragOverGroup = null;
  }

  function handleDrop(e: DragEvent, groupName: string) {
    e.preventDefault();
    dragOverGroup = null;
    if (dragEntry && onEntryMove) {
      onEntryMove(dragEntry, groupName);
    }
    dragEntry = null;
  }
</script>

<div class="im-board">
  {#each groups as group (group.groupName)}
    <div
      class="im-board-column"
      class:im-board-column-dragover={dragOverGroup === group.groupName}
      ondragover={(e) => handleDragOver(e, group.groupName)}
      ondragleave={handleDragLeave}
      ondrop={(e) => handleDrop(e, group.groupName)}
      role="list"
    >
      <div class="im-board-column-header">
        <PropertyBadge
          value={group.groupName}
          color={group.groupColor}
        />
        <span class="im-board-column-count">{group.entries.length}</span>
      </div>

      <div class="im-board-column-body">
        {#each group.entries as entry (entry.path)}
          <button
            class="im-board-card"
            draggable="true"
            ondragstart={(e) => handleDragStart(e, entry)}
            onclick={() => onEntryClick?.(entry)}
            type="button"
            role="listitem"
          >
            <div class="im-board-card-title">
              <IconDisplay icon={entry.icon} size={16} />
              <span>{entry.title}</span>
            </div>
          </button>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .im-board {
    display: flex;
    gap: 12px;
    padding: 8px;
    overflow-x: auto;
    min-height: 200px;
  }
  .im-board-column {
    min-width: 220px;
    max-width: 300px;
    flex-shrink: 0;
    background: var(--background-secondary);
    border-radius: 6px;
    padding: 8px;
    transition: background 0.15s;
  }
  .im-board-column-dragover {
    background: var(--background-modifier-hover);
  }
  .im-board-column-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 10px;
    font-size: 13px;
    font-weight: 600;
  }
  .im-board-column-count {
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 400;
  }
  .im-board-column-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .im-board-card {
    all: unset;
    cursor: pointer;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    padding: 8px 10px;
    transition: box-shadow 0.15s;
  }
  .im-board-card:hover {
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
  }
  .im-board-card-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
</style>
