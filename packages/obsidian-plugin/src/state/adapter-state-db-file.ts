/**
 * 모바일의 상태 DB 파일 — 볼트 어댑터로 읽고 쓴다(P11, ADR-053). 모바일 앱에는 Node `fs` 가 없다.
 *
 * - 잠금이 없다 — 모바일에서는 CLI 가 볼트 폴더를 열 수 없고, 앱 하나에 플러그인 인스턴스가 하나다(다시 불러오기는
 *   `state-db-handoff` 가 줄 세운다).
 * - 한 번에 갈아 끼운다 — 옆 `.tmp` 에 다 쓰고, 원래 파일을 지우고, 이름을 바꾼다. 어댑터의 이름 바꾸기는 대상이
 *   있으면 던진다. 지운 뒤 이름을 바꾸기 전에 앱이 죽으면 `.tmp` 만 남는다 → 열 때 `.tmp` 를 파일로 되살린다(다 쓴
 *   것이다). 둘 다 있으면 `.tmp` 는 쓰다 만 것이라 지운다.
 * - 쓰기 전에 파일이 이 창이 읽은 그대로인지 크기 · 수정 시각으로 본다 — 클라우드 동기화(iCloud 등)가 다른 기기의
 *   파일로 바꿔 놓았으면 쓰지 않는다(데스크톱과 같은 까닭 — {@link StateDbCopyStaleError}).
 */
import type { DataAdapter } from "obsidian";
import { StateDbCopyStaleError, type HeldStateDbFile } from "./state-db-file.js";

/** 쓰는 어댑터 기능. */
export type StateDbAdapter = Pick<
  DataAdapter,
  "exists" | "stat" | "writeBinary" | "remove" | "rename" | "mkdir"
>;

type AdapterStamp = { readonly size: number; readonly mtime: number } | null;

async function stampOf(adapter: StateDbAdapter, path: string): Promise<AdapterStamp> {
  const stat = await adapter.stat(path);
  return stat ? { size: stat.size, mtime: stat.mtime } : null;
}

function sameStamp(a: AdapterStamp, b: AdapterStamp): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && a.mtime === b.mtime;
}

/** 볼트 경로의 부모 폴더 — 맨 위면 "". */
function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

export class AdapterStateDbFile implements HeldStateDbFile {
  private constructor(
    private readonly adapter: StateDbAdapter,
    /** 볼트 기준 경로. */
    private readonly path: string,
    private seen: AdapterStamp,
  ) {}

  /** 끊긴 갈아 끼우기를 마무리하고 파일을 적어 둔다 — 파일은 이 뒤에 읽는다. */
  static async acquire(adapter: StateDbAdapter, path: string): Promise<AdapterStateDbFile> {
    const temporary = `${path}.tmp`;
    if (await adapter.exists(temporary)) {
      if (await adapter.exists(path)) await adapter.remove(temporary);
      else await adapter.rename(temporary, path);
    }
    return new AdapterStateDbFile(adapter, path, await stampOf(adapter, path));
  }

  async write(data: Uint8Array): Promise<void> {
    if (!sameStamp(await stampOf(this.adapter, this.path), this.seen)) {
      throw new StateDbCopyStaleError(
        "이 창이 읽은 뒤에 다른 곳이 상태 DB 파일을 바꿔 파일에 쓰지 않음",
      );
    }
    const folder = parentOf(this.path);
    if (folder !== "" && !(await this.adapter.exists(folder))) await this.adapter.mkdir(folder);
    const temporary = `${this.path}.tmp`;
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    await this.adapter.writeBinary(temporary, bytes as ArrayBuffer);
    if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
    await this.adapter.rename(temporary, this.path);
    this.seen = await stampOf(this.adapter, this.path);
  }

  /** 잠금이 없다 — 할 일이 없다. */
  release(): void {}
}
