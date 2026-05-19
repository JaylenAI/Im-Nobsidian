import type { ViewConfig } from "../types/view.js";
import type { DBEntry, PropertyValue, GroupedEntries, CalendarEntry } from "./types.js";

export function sortEntries(
  entries: DBEntry[],
  sorts: NonNullable<ViewConfig["sorts"]>,
): DBEntry[] {
  if (sorts.length === 0) return entries;

  return [...entries].sort((a, b) => {
    for (const sort of sorts) {
      const key = sort.property ?? sort.timestamp;
      if (!key) continue;

      const aVal = a.properties[key] ?? null;
      const bVal = b.properties[key] ?? null;
      const cmp = compareValues(aVal, bVal);
      if (cmp !== 0) return sort.direction === "ascending" ? cmp : -cmp;
    }
    return 0;
  });
}

export function groupEntries(
  entries: DBEntry[],
  groupByProperty: string,
  options?: { sort?: "ascending" | "descending"; hideEmptyGroups?: boolean },
): GroupedEntries[] {
  const groups = new Map<string, DBEntry[]>();
  const ungrouped: DBEntry[] = [];

  for (const entry of entries) {
    const val = entry.properties[groupByProperty] ?? null;
    const groupName = extractGroupName(val);

    if (groupName === null) {
      ungrouped.push(entry);
    } else {
      const existing = groups.get(groupName);
      if (existing) {
        existing.push(entry);
      } else {
        groups.set(groupName, [entry]);
      }
    }
  }

  let result: GroupedEntries[] = Array.from(groups.entries()).map(([name, items]) => ({
    groupName: name,
    entries: items,
  }));

  if (options?.sort === "ascending") {
    result.sort((a, b) => a.groupName.localeCompare(b.groupName));
  } else if (options?.sort === "descending") {
    result.sort((a, b) => b.groupName.localeCompare(a.groupName));
  }

  if (ungrouped.length > 0) {
    result.push({ groupName: "그룹 없음", entries: ungrouped });
  }

  if (options?.hideEmptyGroups) {
    result = result.filter((g) => g.entries.length > 0);
  }

  return result;
}

export function extractCalendarEntries(entries: DBEntry[], dateProperty: string): CalendarEntry[] {
  const result: CalendarEntry[] = [];

  for (const entry of entries) {
    const val = entry.properties[dateProperty];
    if (!val) continue;

    if (typeof val === "string") {
      const date = parseDate(val);
      if (date) result.push({ entry, date });
    } else if (typeof val === "object" && val !== null && !Array.isArray(val) && "start" in val) {
      const date = parseDate(val.start);
      if (date) {
        result.push({
          entry,
          date,
          endDate: val.end ? (parseDate(val.end) ?? undefined) : undefined,
        });
      }
    }
  }

  return result;
}

export function filterByMonth(
  calendarEntries: CalendarEntry[],
  year: number,
  month: number,
): CalendarEntry[] {
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
  return calendarEntries.filter((ce) => ce.date.startsWith(monthStr));
}

export function getVisibleProperties(
  viewConfig: ViewConfig,
): Array<{ id: string; name: string; width?: number }> {
  if (!viewConfig.properties) return [];

  return viewConfig.properties
    .filter((p) => p.visible !== false)
    .map((p) => ({
      id: p.propertyId,
      name: p.propertyName ?? p.propertyId,
      width: p.width,
    }));
}

function compareValues(a: PropertyValue, b: PropertyValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.join(",").localeCompare(b.join(","));
  }

  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    if ("start" in a && "start" in b) {
      return (a.start ?? "").localeCompare(b.start ?? "");
    }
  }

  return String(a).localeCompare(String(b));
}

function extractGroupName(val: PropertyValue): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "string") return val || null;
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) return val.length > 0 ? val.join(", ") : null;
  if (typeof val === "object" && "start" in val) return val.start;
  return null;
}

function parseDate(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? null;
}
