/**
 * `path` — 데스크톱이면 Node 의 것(Windows 는 `\`). 모바일이면 `/` 로 잇는 POSIX 꼴 — 모바일에는 볼트 경로뿐이고
 * 그것은 늘 `/` 로 잇는다.
 */
import type * as NodePath from "node:path";
import { nodeModule } from "../node.js";

const node = nodeModule<typeof NodePath>("path");

function normalizePosix(path: string): string {
  if (path === "") return ".";
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  const trailing = path.endsWith("/") ? "/" : "";
  if (joined === "") return absolute ? "/" : `.${trailing}`;
  return `${absolute ? "/" : ""}${joined}${trailing}`;
}

export const posix = {
  sep: "/",
  delimiter: ":",
  normalize: normalizePosix,
  isAbsolute: (path: string): boolean => path.startsWith("/"),
  join: (...parts: string[]): string => {
    const joined = parts.filter((part) => part !== "").join("/");
    return joined === "" ? "." : normalizePosix(joined);
  },
  resolve: (...parts: string[]): string => {
    let resolved = "";
    for (let i = parts.length - 1; i >= 0 && !resolved.startsWith("/"); i--) {
      const part = parts[i]!;
      if (part !== "") resolved = resolved === "" ? part : `${part}/${resolved}`;
    }
    const normalized = normalizePosix(`/${resolved}`);
    return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  },
  // dirname · basename · extname 은 Node(lib/path.js posix)를 그대로 옮겼다 — 끝 `/` · `..` · 점 이름이 까다롭다
  dirname: (path: string): string => {
    if (path.length === 0) return ".";
    const hasRoot = path.startsWith("/");
    let end = -1;
    let matchedSlash = true;
    for (let i = path.length - 1; i >= 1; --i) {
      if (path[i] === "/") {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else matchedSlash = false;
    }
    if (end === -1) return hasRoot ? "/" : ".";
    if (hasRoot && end === 1) return "//";
    return path.slice(0, end);
  },
  basename: (path: string, ext?: string): string => {
    let start = 0;
    let end = -1;
    let matchedSlash = true;
    if (ext !== undefined && ext.length > 0 && ext.length <= path.length) {
      if (ext === path) return "";
      let extIndex = ext.length - 1;
      let firstNonSlashEnd = -1;
      for (let i = path.length - 1; i >= 0; --i) {
        if (path[i] === "/") {
          if (!matchedSlash) {
            start = i + 1;
            break;
          }
        } else {
          if (firstNonSlashEnd === -1) {
            matchedSlash = false;
            firstNonSlashEnd = i + 1;
          }
          if (extIndex >= 0) {
            if (path[i] === ext[extIndex]) {
              if (--extIndex === -1) end = i;
            } else {
              extIndex = -1;
              end = firstNonSlashEnd;
            }
          }
        }
      }
      if (start === end) end = firstNonSlashEnd;
      else if (end === -1) end = path.length;
      return path.slice(start, end);
    }
    for (let i = path.length - 1; i >= 0; --i) {
      if (path[i] === "/") {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
    }
    return end === -1 ? "" : path.slice(start, end);
  },
  extname: (path: string): string => {
    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    // 0: 점 앞에 글자 없음 · 1: 점 둘 이상 · -1: 점 앞에 다른 글자
    let preDotState = 0;
    for (let i = path.length - 1; i >= 0; --i) {
      const char = path[i];
      if (char === "/") {
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
      if (char === ".") {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) preDotState = -1;
    }
    if (
      startDot === -1 ||
      end === -1 ||
      preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    )
      return "";
    return path.slice(startDot, end);
  },
  relative: (from: string, to: string): string => {
    const a = posix.resolve(from).split("/").filter(Boolean);
    const b = posix.resolve(to).split("/").filter(Boolean);
    let same = 0;
    while (same < a.length && same < b.length && a[same] === b[same]) same++;
    return [...a.slice(same).map(() => ".."), ...b.slice(same)].join("/");
  },
};

const path = node ?? (posix as unknown as typeof NodePath);

export const sep = path.sep;
export const delimiter = path.delimiter;
export const normalize = path.normalize;
export const isAbsolute = path.isAbsolute;
export const join = path.join;
export const resolve = path.resolve;
export const dirname = path.dirname;
export const basename = path.basename;
export const extname = path.extname;
export const relative = path.relative;
export default path;
