/**
 * I6 — 첨부(이미지/파일) 불변식.
 *
 * 로컬 임베드 이미지는 Notion 에 업로드(file 타입 image 블록)되고 file_registry 에 전체
 * content_hash 로 등록된다. 같은 첨부를 FileHandler.pushAllFiles 가 폴더 페이지에 standalone
 * 으로 재업로드하지 않는다(image-handler↔file-handler 공유 레지스트리 dedup → 중복 업로드 0).
 * 외부 URL 이미지는 업로드 대상이 아니며 file_registry 에 등록되지 않아 업로드 파일과 구분 보존된다.
 * 무변경 재sync 는 변경감지가 스킵해 재업로드 0.
 *
 * 임계값은 실제 Notion push 를 관찰해 실측 고정(거짓 종료 방지):
 *  - 노트 페이지 file 타입 image 블록 = 1, 폴더(docs) 페이지 file 타입 image 블록 = 0(중복 0).
 *  - file_registry 엔트리: sha256(64 hex), fileType "image", fileSize == 원본 바이트수.
 *  - 외부 URL 은 file_registry 미등록(업로드 파일과 구분).
 *  - 텍스트만 편집 후 재push 시 노트 image 블록 = 1 유지(블록 더블링 0), 폴더 = 0 유지.
 *  - 무변경 sync: push created == 0 && updated == 0.
 *
 * 참고(실측 관찰): 기본 push 는 replace_content 라 노트 블록을 매번 wipe → file_upload 는
 * 1회용이므로 노트 본문이 바뀌면 임베드 이미지는 재업로드+재append 된다(블록 더블링/손실
 * 아님). 따라서 "중복 업로드 0" 은 (1) 무변경 재sync, (2) standalone 폴더 중복 차단 두 축에서
 * 보장한다.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "@notionhq/client";

import {
  SKIP,
  rawNotion,
  createIsolatedRoot,
  createTmpVault,
  makeOrchestrator,
  archivePages,
  cleanupVault,
  sleep,
} from "./harness.js";
import type { StateDB } from "../../src/state/state-db.js";

// 1x1 투명 PNG (70 bytes)
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const EXT_URL = "https://example.com/ext.png";

// 이미지 블록의 내부 타입(file=Notion 업로드, external=외부 URL 참조) 분포.
async function imageKinds(raw: Client, pageId: string): Promise<Record<string, number>> {
  const res = await raw.blocks.children.list({ block_id: pageId, page_size: 100 });
  const kinds: Record<string, number> = {};
  for (const b of res.results as Array<{ type: string; image?: { type: string } }>) {
    if (b.type === "image" && b.image) kinds[b.image.type] = (kinds[b.image.type] ?? 0) + 1;
  }
  return kinds;
}

describe.skipIf(SKIP)("I6 첨부 불변식", () => {
  let raw: Client;
  const createdPageIds: string[] = [];

  beforeAll(() => {
    raw = rawNotion();
  });

  afterAll(async () => {
    await archivePages(raw, createdPageIds);
  });

  function trackPages(stateDb: StateDB): void {
    for (const rec of stateDb.getAll()) {
      if (rec.notionPageId) createdPageIds.push(rec.notionPageId);
    }
  }

  it("로컬 이미지 업로드+레지스트리 dedup + 외부 URL 구분 + 중복 업로드 0", async () => {
    const root = await createIsolatedRoot(raw, "i6-attach");
    createdPageIds.push(root);
    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root);
    const pngBytes = Buffer.from(PNG_B64, "base64");

    // 노트와 이미지를 같은 docs/ 폴더에 둔다 → docs/ 가 Notion 폴더 페이지로 매핑되어
    // FileHandler 가 docs/pic.png 를 standalone 으로도 올릴 조건이 성립(dedup 검증 가능).
    await vaultFs.ensureFolder("docs");
    await vaultFs.writeBinary("docs/pic.png", pngBytes);
    await vaultFs.writeFile(
      "docs/note.md",
      `# 이미지 노트\n\n첫 문단.\n\n![[docs/pic.png]]\n\n외부: ![ext](${EXT_URL})\n\n끝 문단.\n`,
    );

    const push1 = await orchestrator.push();
    trackPages(stateDb);
    expect(push1.failed).toHaveLength(0);
    expect(push1.created, "노트 1건 create").toBe(1);

    const noteRec = stateDb.getByPath("docs/note.md");
    const folderRec = stateDb.getByPath("docs");
    expect(noteRec?.notionPageId, "노트 페이지 미생성").toBeTruthy();
    expect(folderRec?.notionPageId, "docs 폴더 페이지 미생성").toBeTruthy();

    await sleep(2500);

    // 업로드된 로컬 이미지 = 노트 페이지의 file 타입 image 블록 1개.
    const noteImg = await imageKinds(raw, noteRec!.notionPageId!);
    expect(noteImg.file ?? 0, "노트 업로드 이미지(file) 블록 수").toBe(1);

    // 중복 업로드 0: 폴더 페이지에 standalone 이미지 블록이 생기지 않는다.
    const folderImg = await imageKinds(raw, folderRec!.notionPageId!);
    expect(folderImg.file ?? 0, "폴더 standalone 이미지 중복 업로드").toBe(0);
    expect(folderImg.external ?? 0, "폴더 standalone 외부 이미지").toBe(0);

    // file_registry: 로컬 이미지가 전체 content_hash 로 등록됨.
    const reg = stateDb.getFileRegistry("docs/pic.png");
    expect(reg, "로컬 이미지 file_registry 미등록").not.toBeNull();
    expect(reg!.fileHash, "content_hash 가 전체 sha256(64 hex) 아님").toMatch(/^[0-9a-f]{64}$/);
    expect(reg!.fileType, "fileType").toBe("image");
    expect(reg!.fileSize, "file_registry 크기 불일치").toBe(pngBytes.length);

    // 외부 URL 구분 보존: 외부 URL 은 업로드 대상이 아니라 file_registry 에 등록되지 않는다.
    expect(stateDb.isFileRegistered(EXT_URL), "외부 URL 이 업로드 파일로 등록됨").toBe(false);

    // 텍스트만 편집 → 재push: 이미지 블록 더블링 0, 폴더 standalone 중복 0 유지.
    await vaultFs.writeFile(
      "docs/note.md",
      `# 이미지 노트\n\n첫 문단 수정됨.\n\n![[docs/pic.png]]\n\n외부: ![ext](${EXT_URL})\n\n끝 문단.\n`,
    );
    const push2 = await orchestrator.push();
    expect(push2.failed).toHaveLength(0);
    expect(push2.updated, "텍스트 편집 1건 update").toBe(1);
    await sleep(2500);

    const noteImg2 = await imageKinds(raw, noteRec!.notionPageId!);
    expect(noteImg2.file ?? 0, "텍스트 편집 후 이미지 블록 더블링").toBe(1);
    const folderImg2 = await imageKinds(raw, folderRec!.notionPageId!);
    expect(folderImg2.file ?? 0, "텍스트 편집 후 폴더 중복 업로드").toBe(0);

    // 무변경 재sync: 재업로드 0 (변경감지가 노트를 스킵).
    const sync3 = await orchestrator.sync();
    expect(sync3.push.created, "무변경 재sync create").toBe(0);
    expect(sync3.push.updated, "무변경 재sync update").toBe(0);

    await cleanupVault(vault, stateDb);
  });
});
