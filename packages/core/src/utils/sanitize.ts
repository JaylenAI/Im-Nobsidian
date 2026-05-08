// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const TRAILING_DOTS = /\.+$/;
const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export function sanitizeFileName(name: string): string {
  let sanitized = name.replace(INVALID_CHARS, "_").replace(TRAILING_DOTS, "").trim().slice(0, 200);

  if (RESERVED_NAMES.has(sanitized.toUpperCase())) {
    sanitized = `_${sanitized}`;
  }

  if (sanitized.length === 0) {
    sanitized = "_untitled";
  }

  return sanitized;
}
