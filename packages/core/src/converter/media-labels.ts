/**
 * pull 이 Notion 미디어 블록을 볼트 링크로 받을 때 붙이는 표시 — `[🎬 캡션](주소)`. 캡션이 없으면 자리 이름
 * (`[🎬 video](주소)`)을 붙인다. push 는 이 표시로 링크를 미디어 태그로 되돌리고, 첨부 처리는 이 표시로 받을
 * 파일 링크를 고르고 이름에서 뗀다. 세 곳이 각자 목록을 들면 한쪽만 늘어 다른 쪽이 그 링크를 못 알아본다.
 */

/** 자리 이름(미디어 종류) → 표시. 자리 이름은 캡션이 없을 때 링크 글자가 된다. */
export const MEDIA_LABELS = {
  audio: "🔊",
  video: "🎬",
  pdf: "📄",
  file: "📎",
  html: "🌐",
} as const;

export type MediaLabelKind = keyof typeof MEDIA_LABELS;

/** v0.1.x 가 동영상에 붙이던 표시 — 지금은 쓰지 않지만 그 볼트의 링크도 첨부로 알아본다. */
const LEGACY_MEDIA_ICONS = ["🎞"] as const;

/** 캡션 없는 미디어의 자리 이름 — 사람이 적은 캡션이 아니다. */
export const MEDIA_PLACEHOLDER_CAPTIONS: ReadonlySet<string> = new Set(Object.keys(MEDIA_LABELS));

/** 미디어 링크의 글자 — 캡션이 없으면 자리 이름. */
export function mediaLabel(kind: MediaLabelKind, caption: string): string {
  return `${MEDIA_LABELS[kind]} ${caption || kind}`;
}

/** 그 종류의 미디어 링크 `[표시 캡션](주소)` — 그룹 1 = 캡션, 2 = 주소. */
export function mediaLinkRe(kind: MediaLabelKind): RegExp {
  return new RegExp(`\\[${MEDIA_LABELS[kind]}\\s*([^\\]]*)\\]\\(([^)]+)\\)`, "g");
}

/** 링크 글자 앞의 표시 — 옛 표시도 포함한다. */
export const MEDIA_LABEL_PREFIX_RE = new RegExp(
  `^(?:${[...Object.values(MEDIA_LABELS), ...LEGACY_MEDIA_ICONS].join("|")})\\s*`,
  "u",
);
