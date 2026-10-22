import type { NotionColor } from "./types.js";

const NOTION_COLORS: Record<NotionColor, string> = {
  default: "#37352F",
  gray: "#787774",
  brown: "#9F6B53",
  orange: "#D9730D",
  yellow: "#CB912F",
  green: "#448361",
  blue: "#337EA9",
  purple: "#9065B0",
  pink: "#C14C8A",
  red: "#D44C47",
};

const NOTION_BG_COLORS: Record<NotionColor, string> = {
  default: "#F1F1EF",
  gray: "#F1F1EF",
  brown: "#F4EEEE",
  orange: "#FBECDD",
  yellow: "#FBF3DB",
  green: "#EDF3EC",
  blue: "#E7F3F8",
  purple: "#F4F0F7",
  pink: "#F9F0F5",
  red: "#FDEBEC",
};

/** Notion 이 쓰는 색 이름 전부(`default` 포함) — 색을 다루는 다른 곳은 이 목록을 읽는다. */
export const NOTION_COLOR_NAMES = Object.keys(NOTION_COLORS) as readonly NotionColor[];

export function getNotionColor(color: NotionColor | string): string {
  return NOTION_COLORS[color as NotionColor] ?? NOTION_COLORS.default;
}

export function getNotionBgColor(color: NotionColor | string): string {
  return NOTION_BG_COLORS[color as NotionColor] ?? NOTION_BG_COLORS.default;
}

export function generateColorCSS(): string {
  const lines: string[] = [];
  for (const [name, hex] of Object.entries(NOTION_COLORS)) {
    lines.push(`  --notion-color-${name}: ${hex};`);
  }
  for (const [name, hex] of Object.entries(NOTION_BG_COLORS)) {
    lines.push(`  --notion-bg-${name}: ${hex};`);
  }
  return `:root {\n${lines.join("\n")}\n}`;
}
