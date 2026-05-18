<script lang="ts">
  import type { ViewRenderData, DBEntry } from "@im-nobsidian/core";
  import { getVisibleProperties, sortEntries } from "@im-nobsidian/core";
  import IconDisplay from "./components/IconDisplay.svelte";
  import PropertyBadge from "./components/PropertyBadge.svelte";

  interface Props {
    data: ViewRenderData;
    onEntryClick?: (entry: DBEntry) => void;
  }

  let { data, onEntryClick }: Props = $props();

  const columns = $derived(getVisibleProperties(data.viewConfig));

  let sortColumn: string | null = $state(null);
  let sortDir: "ascending" | "descending" = $state("ascending");

  const sortedEntries = $derived.by(() => {
    if (!sortColumn) return data.entries;
    return sortEntries(data.entries, [
      { property: sortColumn, direction: sortDir },
    ]);
  });

  function toggleSort(colName: string) {
    if (sortColumn === colName) {
      sortDir = sortDir === "ascending" ? "descending" : "ascending";
    } else {
      sortColumn = colName;
      sortDir = "ascending";
    }
  }

  function renderValue(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "boolean") return value ? "✓" : "✗";
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "object" && "start" in (value as Record<string, unknown>)) {
      const d = value as { start: string; end?: string };
      return d.end ? `${d.start} → ${d.end}` : d.start;
    }
    return String(value);
  }

  function isSelectLike(propName: string): boolean {
    const schema = data.schema?.[propName];
    return schema?.type === "select" || schema?.type === "status" || schema?.type === "multi_select";
  }
</script>

<div class="im-table-wrapper">
  <table class="im-table">
    <thead>
      <tr>
        <th class="im-table-th im-table-th-title">
          <button class="im-table-sort-btn" onclick={() => toggleSort("title")} type="button">
            제목
            {#if sortColumn === "title"}
              <span class="im-table-sort-icon">{sortDir === "ascending" ? "▲" : "▼"}</span>
            {/if}
          </button>
        </th>
        {#each columns as col (col.id)}
          <th
            class="im-table-th"
            style={col.width ? `width: ${col.width}px` : ""}
          >
            <button class="im-table-sort-btn" onclick={() => toggleSort(col.name)} type="button">
              {col.name}
              {#if sortColumn === col.name}
                <span class="im-table-sort-icon">{sortDir === "ascending" ? "▲" : "▼"}</span>
              {/if}
            </button>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each sortedEntries as entry (entry.path)}
        <tr class="im-table-row" onclick={() => onEntryClick?.(entry)}>
          <td class="im-table-td im-table-td-title">
            <IconDisplay icon={entry.icon} size={16} />
            <span class="im-table-title-text">{entry.title}</span>
          </td>
          {#each columns as col (col.id)}
            {@const value = entry.properties[col.name]}
            <td class="im-table-td">
              {#if isSelectLike(col.name) && typeof value === "string"}
                <PropertyBadge
                  {value}
                  color={data.schema?.[col.name]?.options?.find(o => o.name === value)?.color}
                />
              {:else if Array.isArray(value)}
                <div class="im-table-tags">
                  {#each value as tag}
                    <PropertyBadge
                      value={tag}
                      color={data.schema?.[col.name]?.options?.find(o => o.name === tag)?.color}
                    />
                  {/each}
                </div>
              {:else}
                {renderValue(value)}
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .im-table-wrapper {
    overflow-x: auto;
    padding: 8px;
  }
  .im-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .im-table-th {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 2px solid var(--background-modifier-border);
    white-space: nowrap;
    color: var(--text-muted);
    font-weight: 500;
    font-size: 12px;
  }
  .im-table-sort-btn {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .im-table-sort-icon {
    font-size: 10px;
    opacity: 0.6;
  }
  .im-table-row {
    cursor: pointer;
    transition: background 0.1s;
  }
  .im-table-row:hover {
    background: var(--background-modifier-hover);
  }
  .im-table-td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--background-modifier-border);
    vertical-align: middle;
  }
  .im-table-td-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
  }
  .im-table-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .im-table-tags {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
</style>
