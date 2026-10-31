/** `fs` — 데스크톱이면 Node 의 것, 모바일이면 부를 때 던진다({@link nodeModule}). */
import type * as NodeFs from "node:fs";
import { desktopOnly, nodeModule } from "../node.js";

const fs = nodeModule<typeof NodeFs>("fs");

function pick<K extends keyof typeof NodeFs>(name: K): (typeof NodeFs)[K] {
  return fs ? fs[name] : (desktopOnly(`fs.${String(name)}`) as unknown as (typeof NodeFs)[K]);
}

export const closeSync = pick("closeSync");
export const existsSync = pick("existsSync");
export const lstat = pick("lstat");
export const mkdirSync = pick("mkdirSync");
export const openSync = pick("openSync");
export const readFileSync = pick("readFileSync");
export const readlinkSync = pick("readlinkSync");
export const stat = pick("stat");
export const statSync = pick("statSync");
export const unlinkSync = pick("unlinkSync");
export const unwatchFile = pick("unwatchFile");
export const utimesSync = pick("utimesSync");
export const watch = pick("watch");
export const watchFile = pick("watchFile");
export const writeSync = pick("writeSync");
// chokidar(core 의 CLI 감시)가 이름으로 읽는다 — 플러그인은 부르지 않는다
export const Stats: typeof NodeFs.Stats = fs
  ? fs.Stats
  : (class {} as unknown as typeof NodeFs.Stats);
