/**
 * 페이지 아이콘 · 커버 ↔ frontmatter 의 `icon` · `cover` 값 — I/O 없는 규칙만. 보내고 받는 일은
 * `sync/page-decorations.ts`.
 *
 * frontmatter 에 적는 꼴:
 *
 * | Notion                     | frontmatter                                   |
 * | -------------------------- | --------------------------------------------- |
 * | 이모지                     | `🥑`                                          |
 * | Notion 아이콘(이름 · 색)   | `pizza` (회색) · `pizza:blue`                 |
 * | 워크스페이스 사용자 이모지 | `:bufo:`                                      |
 * | 외부 이미지                | `https://…`                                   |
 * | Notion 에 올린 파일        | 받으면 볼트로 내려받아 `[[이름-icon.png]]`    |
 *
 * 2026-10-23 실측(API 2025-09-03): Notion 아이콘은 색을 빼면 회색으로 만들고, 모르는 이름 · 색은 요청 전체를
 * 거부한다(400). 색은 {@link NATIVE_ICON_COLORS} 열 가지다(공식 문서 «Emoji and icon»).
 */
import { isNotionHostedFileUrl } from "../utils/notion-file-url.js";

/** Notion 아이콘의 색 — 이 밖의 값은 요청이 거부된다. */
export const NATIVE_ICON_COLORS: readonly string[] = [
  "gray",
  "lightgray",
  "brown",
  "yellow",
  "orange",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];

/** 색을 적지 않은 Notion 아이콘의 색 — Notion 이 정한다. 이 색은 frontmatter 에 적지 않는다. */
const DEFAULT_ICON_COLOR = "gray";

/** frontmatter 의 아이콘 · 커버 키. */
export const DECORATION_KEYS = ["icon", "cover"] as const;
export type DecorationKey = (typeof DECORATION_KEYS)[number];

/** 알림에 쓰는 꾸밈 이름 — frontmatter 키를 그대로 보이지 않는다. */
export const DECORATION_LABELS: Readonly<Record<DecorationKey, string>> = {
  icon: "아이콘",
  cover: "커버",
};

/**
 * frontmatter 값이 Notion 에 무엇이 되나.
 *
 * - `request` — 그대로 보낼 아이콘 · 커버 객체
 * - `custom-emoji` — 이름으로 워크스페이스 이모지를 찾아 보낸다
 * - `local` — 볼트의 파일을 올려 보낸다
 * - `hosted` — Notion 에 올린 파일의 서명 주소. 다시 보낼 수 없다(곧 만료된다)
 * - `clear` — 비었다. 지운다
 * - `invalid` — 아이콘 · 커버로 읽을 수 없다
 */
export type DecorationSource =
  | { readonly kind: "request"; readonly request: Readonly<Record<string, unknown>> }
  | { readonly kind: "custom-emoji"; readonly name: string }
  | { readonly kind: "local"; readonly target: string }
  | { readonly kind: "hosted" }
  | { readonly kind: "clear" }
  | { readonly kind: "invalid"; readonly reason: string };

/** Notion 이 돌려준 아이콘 객체(`page.icon`)를 frontmatter 값으로. 모르는 타입 · 없으면 null. */
export function iconValueOf(raw: unknown): { value: string; uploaded: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const icon = raw as {
    type?: string;
    emoji?: string;
    external?: { url?: string };
    file?: { url?: string };
    icon?: { name?: string; color?: string };
    custom_emoji?: { name?: string };
  };
  switch (icon.type) {
    case "emoji":
      return icon.emoji ? { value: icon.emoji, uploaded: false } : null;
    case "icon": {
      const name = icon.icon?.name;
      if (!name) return null;
      const color = icon.icon?.color;
      return {
        value: color && color !== DEFAULT_ICON_COLOR ? `${name}:${color}` : name,
        uploaded: false,
      };
    }
    case "custom_emoji":
      return icon.custom_emoji?.name
        ? { value: `:${icon.custom_emoji.name}:`, uploaded: false }
        : null;
    case "external":
      return icon.external?.url ? { value: icon.external.url, uploaded: false } : null;
    case "file":
      return icon.file?.url ? { value: icon.file.url, uploaded: true } : null;
    default:
      return null;
  }
}

/** frontmatter 의 `icon` 값이 Notion 에 무엇이 되나. */
export function iconSource(value: unknown): DecorationSource {
  const text = textOf(value);
  if (text === null) return { kind: "clear" };
  const common = linkSource(text);
  if (common) return common;
  if (isEmoji(text)) return { kind: "request", request: { type: "emoji", emoji: text } };
  const custom = /^:([^:\s]+):$/.exec(text);
  if (custom) return { kind: "custom-emoji", name: custom[1]! };
  const native = /^([\p{L}\p{N}_ -]+?)(?::([a-z]+))?$/u.exec(text);
  if (native) {
    const [, name, color] = native;
    if (color !== undefined && !NATIVE_ICON_COLORS.includes(color)) {
      return { kind: "invalid", reason: `Notion 아이콘 색이 아니다(${color})` };
    }
    return {
      kind: "request",
      request: { type: "icon", icon: { name: name!.trim(), color: color ?? DEFAULT_ICON_COLOR } },
    };
  }
  return {
    kind: "invalid",
    reason: "이모지 · Notion 아이콘 이름 · 이미지 주소 · [[파일]] 이 아니다",
  };
}

/** frontmatter 의 `cover` 값이 Notion 에 무엇이 되나. */
export function coverSource(value: unknown): DecorationSource {
  const text = textOf(value);
  if (text === null) return { kind: "clear" };
  return linkSource(text) ?? { kind: "invalid", reason: "이미지 주소 · [[파일]] 이 아니다" };
}

/** 이 값을 아이콘 · 커버로 보낼 수 있는가 — 읽을 수 없거나 비었으면 아니다. */
export function isDecorationValue(key: DecorationKey, value: unknown): boolean {
  const source = key === "icon" ? iconSource(value) : coverSource(value);
  return source.kind !== "invalid" && source.kind !== "clear";
}

/** 주소 · 볼트 파일 — 아이콘과 커버가 같다. 아니면 null. */
function linkSource(text: string): DecorationSource | null {
  const wikilink = /^!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(text);
  if (wikilink) return { kind: "local", target: wikilink[1]!.trim() };
  if (/^https?:\/\//i.test(text)) {
    if (isNotionHostedFileUrl(text)) return { kind: "hosted" };
    return { kind: "request", request: { type: "external", external: { url: text } } };
  }
  return null;
}

function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return String(value).trim() || null;
  return value.trim() || null;
}

/** 글자 하나(이모지 하나 · 국기 · 키캡)인가 — 조합 이모지(ZWJ)도 하나다. */
function isEmoji(text: string): boolean {
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(text)) return false;
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  return segments.length === 1;
}
