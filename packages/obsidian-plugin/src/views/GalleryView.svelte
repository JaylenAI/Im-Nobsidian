<script lang="ts">
  import type { ViewRenderData, DBEntry } from "@im-nobsidian/core";
  import CoverImage from "./components/CoverImage.svelte";
  import IconDisplay from "./components/IconDisplay.svelte";
  import PropertyBadge from "./components/PropertyBadge.svelte";
  import { getVisibleProperties } from "@im-nobsidian/core";

  interface Props {
    data: ViewRenderData;
    onEntryClick?: (entry: DBEntry) => void;
  }

  let { data, onEntryClick }: Props = $props();

  const coverSize = $derived(data.viewConfig.coverSize ?? "medium");
  const coverAspect = $derived(data.viewConfig.coverAspect ?? "cover");
  const visibleProps = $derived(getVisibleProperties(data.viewConfig));
</script>

<div class="im-gallery">
  {#each data.entries as entry (entry.path)}
    <button
      class="im-gallery-card"
      onclick={() => onEntryClick?.(entry)}
      type="button"
    >
      <CoverImage
        src={entry.cover}
        alt={entry.title}
        aspect={coverAspect}
        size={coverSize}
      />
      <div class="im-gallery-card-body">
        <div class="im-gallery-card-title">
          <IconDisplay icon={entry.icon} size={18} />
          <span class="im-gallery-card-title-text">{entry.title}</span>
        </div>
        {#if visibleProps.length > 0}
          <div class="im-gallery-card-props">
            {#each visibleProps as prop (prop.id)}
              {@const value = entry.properties[prop.name]}
              {#if value != null}
                <div class="im-gallery-card-prop">
                  <span class="im-gallery-card-prop-label">{prop.name}</span>
                  {#if typeof value === "string"}
                    <PropertyBadge
                      {value}
                      color={data.schema?.[prop.name]?.options?.find(o => o.name === value)?.color}
                    />
                  {:else if Array.isArray(value)}
                    {#each value as tag}
                      <PropertyBadge
                        value={tag}
                        color={data.schema?.[prop.name]?.options?.find(o => o.name === tag)?.color}
                      />
                    {/each}
                  {:else if typeof value === "boolean"}
                    <span class="im-gallery-card-prop-value">{value ? "✓" : "✗"}</span>
                  {:else}
                    <span class="im-gallery-card-prop-value">{String(value)}</span>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    </button>
  {/each}
</div>

<style>
  .im-gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
    padding: 8px;
  }
  .im-gallery-card {
    all: unset;
    cursor: pointer;
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--background-primary);
    transition: box-shadow 0.15s;
    display: flex;
    flex-direction: column;
  }
  .im-gallery-card:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  }
  .im-gallery-card-body {
    padding: 10px 12px;
  }
  .im-gallery-card-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: 14px;
    margin-bottom: 6px;
  }
  .im-gallery-card-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .im-gallery-card-props {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .im-gallery-card-prop {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .im-gallery-card-prop-label {
    color: var(--text-muted);
    min-width: 50px;
    flex-shrink: 0;
  }
  .im-gallery-card-prop-value {
    color: var(--text-normal);
  }
</style>
