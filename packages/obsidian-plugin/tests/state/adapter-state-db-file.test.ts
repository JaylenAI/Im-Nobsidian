/**
 * P11 — 모바일의 상태 DB 파일(볼트 어댑터). 한 번에 갈아 끼우고, 끊긴 갈아 끼우기를 열 때 마무리하고, 다른 곳(클라우드
 * 동기화)이 바꾼 파일에는 쓰지 않는다.
 */
import { describe, it, expect } from "vitest";
import { AdapterStateDbFile } from "../../src/state/adapter-state-db-file.js";
import { StateDbCopyStaleError } from "../../src/state/state-db-file.js";
import { MemoryVault } from "../helpers/mobile-host.js";

const PATH = ".im-nobsidian/sync.db";
const bytes = (...values: number[]) => new Uint8Array(values);
const memory = () => new MemoryVault({ TFile: class {}, TFolder: class {} } as never);

describe("AdapterStateDbFile", () => {
  it("처음 — 폴더를 만들고 쓴다, .tmp 는 남지 않는다", async () => {
    const vault = memory();
    const file = await AdapterStateDbFile.acquire(vault.adapter as never, PATH);
    await file.write(bytes(1, 2, 3));
    expect([...vault.files.get(PATH)!.data]).toEqual([1, 2, 3]);
    expect(vault.files.has(`${PATH}.tmp`)).toBe(false);
    await file.write(bytes(4));
    expect([...vault.files.get(PATH)!.data]).toEqual([4]);
  });

  it("바이트 배열의 일부(subarray)여도 그 부분만 쓴다", async () => {
    const vault = memory();
    const file = await AdapterStateDbFile.acquire(vault.adapter as never, PATH);
    await file.write(bytes(9, 1, 2, 9).subarray(1, 3));
    expect([...vault.files.get(PATH)!.data]).toEqual([1, 2]);
  });

  it("지운 뒤 이름을 바꾸기 전에 끊겼으면 .tmp 를 파일로 되살린다", async () => {
    const vault = memory();
    vault.write(`${PATH}.tmp`, bytes(7, 7));
    await AdapterStateDbFile.acquire(vault.adapter as never, PATH);
    expect([...vault.files.get(PATH)!.data]).toEqual([7, 7]);
    expect(vault.files.has(`${PATH}.tmp`)).toBe(false);
  });

  it("둘 다 있으면 .tmp 는 쓰다 만 것 — 지우고 파일을 둔다", async () => {
    const vault = memory();
    vault.write(PATH, bytes(1));
    vault.write(`${PATH}.tmp`, bytes(2));
    await AdapterStateDbFile.acquire(vault.adapter as never, PATH);
    expect([...vault.files.get(PATH)!.data]).toEqual([1]);
    expect(vault.files.has(`${PATH}.tmp`)).toBe(false);
  });

  it("읽은 뒤에 다른 곳이 바꾼 파일에는 쓰지 않는다", async () => {
    const vault = memory();
    vault.write(PATH, bytes(1));
    const file = await AdapterStateDbFile.acquire(vault.adapter as never, PATH);
    vault.write(PATH, bytes(1, 1)); // 다른 기기의 파일이 들어왔다
    await expect(file.write(bytes(5))).rejects.toBeInstanceOf(StateDbCopyStaleError);
    expect([...vault.files.get(PATH)!.data]).toEqual([1, 1]);
  });

  it("읽은 뒤에 다른 곳이 지웠어도 쓰지 않는다 · 처음엔 없던 파일이 생겼어도", async () => {
    const vault = memory();
    vault.write(PATH, bytes(1));
    const held = await AdapterStateDbFile.acquire(vault.adapter as never, PATH);
    await vault.adapter.remove(PATH);
    await expect(held.write(bytes(5))).rejects.toBeInstanceOf(StateDbCopyStaleError);

    const fresh = memory();
    const empty = await AdapterStateDbFile.acquire(fresh.adapter as never, PATH);
    fresh.write(PATH, bytes(3));
    await expect(empty.write(bytes(5))).rejects.toBeInstanceOf(StateDbCopyStaleError);
  });

  it("제가 쓴 뒤로는 이어 쓴다 — 제 쓰기를 다른 곳의 것으로 보지 않는다", async () => {
    const vault = memory();
    const file = await AdapterStateDbFile.acquire(vault.adapter as never, PATH);
    for (let i = 0; i < 5; i++) await file.write(bytes(i));
    expect([...vault.files.get(PATH)!.data]).toEqual([4]);
  });
});
