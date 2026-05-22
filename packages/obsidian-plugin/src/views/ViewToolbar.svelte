<script lang="ts">
  import type { PropertySchema } from "@im-nobsidian/core";

  interface Props {
    searchQuery: string;
    sortProperty: string;
    sortDirection: "ascending" | "descending";
    propertyNames: string[];
    schema?: Record<string, PropertySchema>;
    onSearchChange: (query: string) => void;
    onSortChange: (property: string, direction: "ascending" | "descending") => void;
    onAddEntry?: () => void;
  }

  let {
    searchQuery,
    sortProperty,
    sortDirection,
    propertyNames,
    schema,
    onSearchChange,
    onSortChange,
    onAddEntry,
  }: Props = $props();

  let showSortMenu = $state(false);

  function handleSortSelect(prop: string) {
    if (prop === sortProperty) {
      onSortChange(prop, sortDirection === "ascending" ? "descending" : "ascending");
    } else {
      onSortChange(prop, "ascending");
    }
    showSortMenu = false;
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest(".im-toolbar-sort-wrapper")) {
      showSortMenu = false;
    }
  }
</script>

<svelte:document onclick={handleClickOutside} />

<div class="im-toolbar">
  <div class="im-toolbar-search">
    <svg class="im-toolbar-search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
    <input
      class="im-toolbar-search-input"
      type="text"
      placeholder="검색..."
      value={searchQuery}
      oninput={(e) => onSearchChange(e.currentTarget.value)}
    />
    {#if searchQuery}
      <button class="im-toolbar-search-clear" onclick={() => onSearchChange("")} type="button">✕</button>
    {/if}
  </div>

  <div class="im-toolbar-actions">
    <div class="im-toolbar-sort-wrapper">
      <button
        class="im-toolbar-btn"
        class:im-toolbar-btn-active={!!sortProperty}
        onclick={() => { showSortMenu = !showSortMenu; }}
        type="button"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="8" y2="18"/>
        </svg>
        정렬
        {#if sortProperty}
          <span class="im-toolbar-btn-indicator">{sortDirection === "ascending" ? "▲" : "▼"}</span>
        {/if}
      </button>

      {#if showSortMenu}
        <div class="im-toolbar-dropdown">
          <button
            class="im-toolbar-dropdown-item"
            class:im-toolbar-dropdown-item-active={sortProperty === "title"}
            onclick={() => handleSortSelect("title")}
            type="button"
          >
            제목
            {#if sortProperty === "title"}
              <span>{sortDirection === "ascending" ? "▲" : "▼"}</span>
            {/if}
          </button>
          {#each propertyNames as name}
            <button
              class="im-toolbar-dropdown-item"
              class:im-toolbar-dropdown-item-active={sortProperty === name}
              onclick={() => handleSortSelect(name)}
              type="button"
            >
              {name}
              {#if sortProperty === name}
                <span>{sortDirection === "ascending" ? "▲" : "▼"}</span>
              {/if}
            </button>
          {/each}
          {#if sortProperty}
            <div class="im-toolbar-dropdown-divider"></div>
            <button
              class="im-toolbar-dropdown-item im-toolbar-dropdown-item-clear"
              onclick={() => { onSortChange("", "ascending"); showSortMenu = false; }}
              type="button"
            >
              정렬 해제
            </button>
          {/if}
        </div>
      {/if}
    </div>

    {#if onAddEntry}
      <button class="im-toolbar-btn im-toolbar-btn-add" onclick={onAddEntry} type="button">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        새 항목
      </button>
    {/if}
  </div>
</div>

<style>
  .im-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--background-modifier-border);
    background: var(--background-primary);
  }
  .im-toolbar-search {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    background: var(--background-secondary);
    border-radius: 4px;
    padding: 4px 8px;
  }
  .im-toolbar-search-icon {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .im-toolbar-search-input {
    all: unset;
    flex: 1;
    font-size: 13px;
    min-width: 0;
  }
  .im-toolbar-search-input::placeholder {
    color: var(--text-faint);
  }
  .im-toolbar-search-clear {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    color: var(--text-muted);
    padding: 0 4px;
  }
  .im-toolbar-search-clear:hover {
    color: var(--text-normal);
  }
  .im-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .im-toolbar-btn {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .im-toolbar-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }
  .im-toolbar-btn-active {
    color: var(--interactive-accent);
  }
  .im-toolbar-btn-add {
    color: var(--interactive-accent);
    font-weight: 500;
  }
  .im-toolbar-btn-indicator {
    font-size: 10px;
  }
  .im-toolbar-sort-wrapper {
    position: relative;
  }
  .im-toolbar-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    min-width: 160px;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 100;
    padding: 4px;
    max-height: 240px;
    overflow-y: auto;
  }
  .im-toolbar-dropdown-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 13px;
    box-sizing: border-box;
  }
  .im-toolbar-dropdown-item:hover {
    background: var(--background-modifier-hover);
  }
  .im-toolbar-dropdown-item-active {
    color: var(--interactive-accent);
    font-weight: 500;
  }
  .im-toolbar-dropdown-item-clear {
    color: var(--text-error);
  }
  .im-toolbar-dropdown-divider {
    height: 1px;
    background: var(--background-modifier-border);
    margin: 4px 0;
  }
</style>
