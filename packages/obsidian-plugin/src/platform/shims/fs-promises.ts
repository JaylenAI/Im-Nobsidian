/** `fs/promises` — 데스크톱이면 Node 의 것, 모바일이면 부를 때 던진다({@link nodeModule}). */
import type * as NodeFsPromises from "node:fs/promises";
import { desktopOnly, nodeModule } from "../node.js";

const fsp = nodeModule<typeof NodeFsPromises>("fs/promises");

function pick<K extends keyof typeof NodeFsPromises>(name: K): (typeof NodeFsPromises)[K] {
  return fsp
    ? fsp[name]
    : (desktopOnly(`fs/promises.${String(name)}`) as unknown as (typeof NodeFsPromises)[K]);
}

export const lstat = pick("lstat");
export const mkdir = pick("mkdir");
export const open = pick("open");
export const readdir = pick("readdir");
export const readFile = pick("readFile");
export const realpath = pick("realpath");
export const rename = pick("rename");
export const rmdir = pick("rmdir");
export const stat = pick("stat");
export const unlink = pick("unlink");
export const writeFile = pick("writeFile");
