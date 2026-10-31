/** `os` — 데스크톱이면 Node 의 것. 모바일의 이름은 상태 DB 잠금(데스크톱 전용)만 읽어 이름표로 둔다. */
import type * as NodeOs from "node:os";
import { nodeModule } from "../node.js";

const os = nodeModule<typeof NodeOs>("os");

export const hostname: () => string = os ? os.hostname : () => "mobile";
export const type: () => string = os ? os.type : () => "mobile";
