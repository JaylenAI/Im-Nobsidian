/** `url` — 데스크톱이면 Node 의 것, 모바일이면 웹의 `URL`. */
import type * as NodeUrl from "node:url";
import { desktopOnly, nodeModule } from "../node.js";

const url = nodeModule<typeof NodeUrl>("url");

export const URL: typeof globalThis.URL = (url?.URL as typeof globalThis.URL) ?? globalThis.URL;
export const URLSearchParams: typeof globalThis.URLSearchParams =
  (url?.URLSearchParams as typeof globalThis.URLSearchParams) ?? globalThis.URLSearchParams;
export const fileURLToPath: typeof NodeUrl.fileURLToPath =
  url?.fileURLToPath ?? (desktopOnly("url.fileURLToPath") as typeof NodeUrl.fileURLToPath);
