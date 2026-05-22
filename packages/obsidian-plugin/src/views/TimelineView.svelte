<script lang="ts">
  import type { ViewRenderData, DBEntry, CalendarEntry } from "@im-nobsidian/core";
  import IconDisplay from "./components/IconDisplay.svelte";
  import PropertyBadge from "./components/PropertyBadge.svelte";

  interface Props {
    data: ViewRenderData;
    onEntryClick?: (entry: DBEntry) => void;
  }

  let { data, onEntryClick }: Props = $props();

  const calendarEntries = $derived(data.calendarEntries ?? []);

  const sortedEntries = $derived.by(() => {
    return [...calendarEntries].sort((a, b) => a.date.localeCompare(b.date));
  });

  const groupedByMonth = $derived.by(() => {
    const groups = new Map<string, CalendarEntry[]>();
    for (const ce of sortedEntries) {
      const monthKey = ce.date.substring(0, 7);
      const existing = groups.get(monthKey);
      if (existing) {
        existing.push(ce);
      } else {
        groups.set(monthKey, [ce]);
      }
    }
    return Array.from(groups.entries());
  });

  function formatMonthLabel(monthKey: string): string {
    const [y, m] = monthKey.split("-");
    return `${y}년 ${parseInt(m!)}월`;
  }

  function formatDay(date: string): string {
    const d = date.split("-")[2];
    return d ? String(parseInt(d)) : "";
  }

  function getWeekday(date: string): string {
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    const d = new Date(date + "T00:00:00");
    return days[d.getDay()] ?? "";
  }

  function getStatusProp(entry: DBEntry): { value: string; color?: string } | null {
    const schema = data.schema;
    if (!schema) return null;
    for (const [name, s] of Object.entries(schema)) {
      if (s.type === "select" || s.type === "status") {
        const val = entry.properties[name];
        if (typeof val === "string" && val) {
          return { value: val, color: s.options?.find(o => o.name === val)?.color };
        }
      }
    }
    return null;
  }
</script>

<div class="im-timeline">
  {#if groupedByMonth.length === 0}
    <div class="im-timeline-empty">날짜 속성이 있는 항목이 없습니다</div>
  {:else}
    {#each groupedByMonth as [monthKey, entries] (monthKey)}
      <div class="im-timeline-month">
        <div class="im-timeline-month-label">{formatMonthLabel(monthKey)}</div>
        <div class="im-timeline-items">
          {#each entries as ce (ce.entry.path + ce.date)}
            <button
              class="im-timeline-item"
              onclick={() => onEntryClick?.(ce.entry)}
              type="button"
            >
              <div class="im-timeline-date-col">
                <span class="im-timeline-day">{formatDay(ce.date)}</span>
                <span class="im-timeline-weekday">{getWeekday(ce.date)}</span>
              </div>
              <div class="im-timeline-dot"></div>
              <div class="im-timeline-content">
                <div class="im-timeline-title-row">
                  <IconDisplay icon={ce.entry.icon} size={16} />
                  <span class="im-timeline-title">{ce.entry.title}</span>
                </div>
                {#if ce.endDate}
                  <span class="im-timeline-range">{ce.date} → {ce.endDate}</span>
                {/if}
                {#if getStatusProp(ce.entry)}
                  {@const status = getStatusProp(ce.entry)}
                  {#if status}
                    <PropertyBadge value={status.value} color={status.color} />
                  {/if}
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .im-timeline {
    padding: 8px 12px;
  }
  .im-timeline-empty {
    text-align: center;
    padding: 40px 20px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .im-timeline-month {
    margin-bottom: 16px;
  }
  .im-timeline-month-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 8px;
    padding-left: 60px;
  }
  .im-timeline-items {
    display: flex;
    flex-direction: column;
  }
  .im-timeline-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 8px 0;
    position: relative;
    transition: background 0.1s;
    border-radius: 4px;
    padding-left: 4px;
    padding-right: 4px;
  }
  .im-timeline-item:hover {
    background: var(--background-modifier-hover);
  }
  .im-timeline-date-col {
    width: 44px;
    flex-shrink: 0;
    text-align: right;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }
  .im-timeline-day {
    font-size: 18px;
    font-weight: 700;
    line-height: 1.2;
    color: var(--text-normal);
  }
  .im-timeline-weekday {
    font-size: 11px;
    color: var(--text-muted);
  }
  .im-timeline-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--interactive-accent);
    flex-shrink: 0;
    margin-top: 6px;
    position: relative;
  }
  .im-timeline-dot::after {
    content: "";
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    width: 2px;
    height: calc(100% + 16px);
    background: var(--background-modifier-border);
  }
  .im-timeline-item:last-child .im-timeline-dot::after {
    display: none;
  }
  .im-timeline-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .im-timeline-title-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .im-timeline-title {
    font-size: 14px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .im-timeline-range {
    font-size: 11px;
    color: var(--text-muted);
  }
</style>
