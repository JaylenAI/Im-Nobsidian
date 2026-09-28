/**
 * 파일을 한 번에 갈아 끼운다 — 옆 임시 파일에 다 쓰고 디스크에 내린 뒤 이름을 바꾼다. 쓰는 도중에 프로세스가
 * 죽어도(강제 종료 · 전원) 파일은 옛 것이거나 새 것이다.
 *
 * 상태 DB 는 예전에 어댑터 `writeBinary`(`fs.writeFile`) 로 파일을 바로 덮었다. 파일을 비우고 처음부터 쓰므로
 * 도중에 죽으면 잘린 파일이 남고, 동기화 기록을 잃는다. Obsidian 어댑터의 이름 바꾸기는 대상이 있으면 던져 덮어
 * 쓰지 못하므로 Node 의 `fs` 로 쓴다 — 플러그인은 데스크톱 전용이다(manifest `isDesktopOnly`).
 */
import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeFileAtomically(path: string, data: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  const file = await open(temporary, "w");
  try {
    await file.writeFile(data);
    // 이름을 바꾸기 전에 내용을 디스크에 내린다 — 아니면 전원이 나갔을 때 바뀐 이름만 남고 내용이 빌 수 있다.
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
