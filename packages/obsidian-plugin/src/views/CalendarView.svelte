<script lang="ts">
  import type { ViewRenderData, DBEntry, CalendarEntry } from "@im-nobsidian/core";
  import { filterByMonth } from "@im-nobsidian/core";
  import IconDisplay from "./components/IconDisplay.svelte";

  interface Props {
    data: ViewRenderData;
    onEntryClick?: (entry: DBEntry) => void;
    onDateClick?: (date: string) => void;
  }

  let { data, onEntryClick, onDateClick }: Props = $props();

  const today = new Date();
  let year = $state(today.getFullYear());
  let month = $state(today.getMonth() + 1);

  const calendarEntries = $derived(data.calendarEntries ?? []);
  const monthEntries = $derived(filterByMonth(calendarEntries, year, month));

  const daysInMonth = $derived(new Date(year, month, 0).getDate());
  const firstDayOfWeek = $derived(new Date(year, month - 1, 1).getDay());
  const weekDays = ["일", "월", "화", "수", "목", "금", "토"];

  const calendarGrid = $derived.by(() => {
    const grid: Array<{ day: number | null; entries: CalendarEntry[] }> = [];

    for (let i = 0; i < firstDayOfWeek; i++) {
      grid.push({ day: null, entries: [] });
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dayEntries = monthEntries.filter((ce) => ce.date === dateStr);
      grid.push({ day: d, entries: dayEntries });
    }

    return grid;
  });

  function prevMonth() {
    if (month === 1) {
      year--;
      month = 12;
    } else {
      month--;
    }
  }

  function nextMonth() {
    if (month === 12) {
      year++;
      month = 1;
    } else {
      month++;
    }
  }

  function goToday() {
    year = today.getFullYear();
    month = today.getMonth() + 1;
  }

  function formatDate(day: number): string {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
</script>

<div class="im-calendar">
  <div class="im-calendar-header">
    <button class="im-calendar-nav" onclick={prevMonth} type="button">&lt;</button>
    <button class="im-calendar-today" onclick={goToday} type="button">오늘</button>
    <span class="im-calendar-title">{year}년 {month}월</span>
    <button class="im-calendar-nav" onclick={nextMonth} type="button">&gt;</button>
  </div>

  <div class="im-calendar-grid">
    {#each weekDays as day}
      <div class="im-calendar-weekday">{day}</div>
    {/each}

    {#each calendarGrid as cell, i (i)}
      {#if cell.day === null}
        <div class="im-calendar-cell im-calendar-cell-empty"></div>
      {:else}
        <div
          class="im-calendar-cell"
          class:im-calendar-cell-today={
            cell.day === today.getDate() &&
            month === today.getMonth() + 1 &&
            year === today.getFullYear()
          }
          class:im-calendar-cell-has-entries={cell.entries.length > 0}
          onclick={() => {
            if (cell.entries.length === 1) {
              onEntryClick?.(cell.entries[0]!.entry);
            } else if (cell.day) {
              onDateClick?.(formatDate(cell.day));
            }
          }}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              if (cell.entries.length === 1) onEntryClick?.(cell.entries[0]!.entry);
              else if (cell.day) onDateClick?.(formatDate(cell.day));
            }
          }}
          role="button"
          tabindex="0"
        >
          <span class="im-calendar-day">{cell.day}</span>
          {#if cell.entries.length > 0}
            <div class="im-calendar-entries">
              {#each cell.entries.slice(0, 3) as ce (ce.entry.path)}
                <button
                  class="im-calendar-entry"
                  type="button"
                  onclick={(e) => { e.stopPropagation(); onEntryClick?.(ce.entry); }}
                >
                  <IconDisplay icon={ce.entry.icon} size={12} />
                  <span class="im-calendar-entry-title">{ce.entry.title}</span>
                </button>
              {/each}
              {#if cell.entries.length > 3}
                <span class="im-calendar-more">+{cell.entries.length - 3}</span>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
</div>

<style>
  .im-calendar {
    padding: 8px;
  }
  .im-calendar-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .im-calendar-title {
    font-weight: 600;
    font-size: 16px;
    flex: 1;
    text-align: center;
  }
  .im-calendar-nav,
  .im-calendar-today {
    all: unset;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 13px;
    color: var(--text-muted);
  }
  .im-calendar-nav:hover,
  .im-calendar-today:hover {
    background: var(--background-modifier-hover);
  }
  .im-calendar-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
    background: var(--background-modifier-border);
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    overflow: hidden;
  }
  .im-calendar-weekday {
    text-align: center;
    padding: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--background-secondary);
  }
  .im-calendar-cell {
    all: unset;
    min-height: 80px;
    padding: 4px;
    background: var(--background-primary);
    cursor: pointer;
    display: flex;
    flex-direction: column;
  }
  .im-calendar-cell:hover {
    background: var(--background-modifier-hover);
  }
  .im-calendar-cell-empty {
    background: var(--background-secondary);
    cursor: default;
  }
  .im-calendar-cell-today .im-calendar-day {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-radius: 50%;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .im-calendar-day {
    font-size: 12px;
    margin-bottom: 2px;
  }
  .im-calendar-entries {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .im-calendar-entry {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--background-secondary);
    cursor: pointer;
    font-size: 11px;
  }
  .im-calendar-entry:hover {
    background: var(--background-modifier-hover);
  }
  .im-calendar-entry-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .im-calendar-more {
    font-size: 10px;
    color: var(--text-muted);
    padding-left: 4px;
  }
</style>
