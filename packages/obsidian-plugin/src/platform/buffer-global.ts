/**
 * 전역 `Buffer` — core 는 노트 · 첨부 바이트를 `Buffer` 로 다룬다. 데스크톱(Electron)에는 있고 모바일 앱에는 없다 —
 * 없을 때만 npm `buffer`(Node 와 같은 API)를 둔다. main.ts 가 맨 먼저 읽는다(P11).
 */
import { Buffer as BufferPolyfill } from "buffer/index.js";

const scope = globalThis as { Buffer?: unknown };
if (scope.Buffer === undefined) scope.Buffer = BufferPolyfill;
