<script lang="ts">
  import type { ViewRenderData, DBEntry } from "@im-nobsidian/core";
  import { getVisibleProperties } from "@im-nobsidian/core";
  import IconDisplay from "./components/IconDisplay.svelte";
  import PropertyBadge from "./components/PropertyBadge.svelte";

  interface Props {
    data: ViewRenderData;
    onEntryClick?: (entry: DBEntry) => void;
  }

  let { data, onEntryClick }: Props = $props();

  const visibleProps = $derived(getVisibleProperties(data.viewConfig).slice(0, 3));

  function renderCompact(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "boolean") return value ? "✓" : "✗";
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "object" && "start" in (value as Record<string, unknown>)) {
      return (value as { start: string }).start;
    }
    return String(value);
  }

  function isSelectLike(propName: string): boolean {
    const schema = data.schema?.[propName];
    return schema?.type === "select" || schema?.type === "status" || schema?.type === "multi_select";
  }
</script>

<div class="im-list">
  {#each data.entries as entry (entry.path)}
    <button
      class="im-list-item"
      onclick={() => onEntryClick?.(entry)}
      type="button"
    >
      <div class="im-list-item-main">
        <IconDisplay icon={entry.icon} size={18} />
        <span class="im-list-item-title">{entry.title}</span>
      </div>
      {#if visibleProps.length > 0}
        <div class="im-list-item-props">
          {#each visibleProps as prop (prop.id)}
            {@const value = entry.properties[prop.name]}
            {#if value != null}
              {#if isSelectLike(prop.name) && typeof value === "string"}
                <PropertyBadge
                  {value}
                  color={data.schema?.[prop.name]?.options?.find(o => o.name === value)?.color}
                />
              {:else if Array.isArray(value)}
                {#each value.slice(0, 2) as tag}
                  <PropertyBadge
                    value={tag}
                    color={data.schema?.[prop.name]?.options?.find(o => o.name === tag)?.color}
                  />
                {/each}
                {#if value.length > 2}
                  <span class="im-list-item-more">+{value.length - 2}</span>
                {/if}
              {:else}
                <span class="im-list-item-value">{renderCompact(value)}</span>
              {/if}
            {/if}
          {/each}
        </div>
      {/if}
    </button>
  {/each}
  {#if data.entries.length === 0}
    <div class="im-list-empty">항목이 없습니다</div>
  {/if}
</div>

<style>
  .im-list {
    display: flex;
    flex-direction: column;
    padding: 4px 8px;
  }
  .im-list-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--background-modifier-border);
    transition: background 0.1s;
  }
  .im-list-item:hover {
    background: var(--background-modifier-hover);
  }
  .im-list-item-main {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }
  .im-list-item-title {
    font-size: 14px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .im-list-item-props {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .im-list-item-value {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .im-list-item-more {
    font-size: 11px;
    color: var(--text-muted);
  }
  .im-list-empty {
    text-align: center;
    padding: 40px 20px;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
