/**
 * S-05 — push 가 올린 미디어를 페이지마다 적어 두고, pull 이 파일 id 로 찾는다.
 *
 * 스키마를 바꾸지 않고 sync_metadata 한 줄(`uploaded_media:<페이지>`)에 적는다. 두 상태 DB
 * 구현(better-sqlite3 · sql.js)이 같은 getMeta/setMeta 로 읽고 쓴다 — 여기서는 실제 StateDB(임시
 * 파일)로 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { StateDB } from "../../src/state/state-db.js";
import {
  recallUploadedMedia,
  rememberUploadedMedia,
  type UploadedMedia,
} from "../../src/sync/uploaded-media.js";
import { setLogger } from "../../src/utils/logger.js";

const PAGE_ID = "3e713b18-0a2c-4d5e-9f10-1b2c3d4e5f60";
const PAGE_KEY = "uploaded_media:3e713b180a2c4d5e9f101b2c3d4e5f60";

const IMG: UploadedMedia = {
  fileId: "0f5a3c1e-7b2d-4e8f-9a61-3c2b1d0e9f87",
  target: "assets/사진.png|워크숍|300",
  localPath: "assets/사진.png",
};
const DOC: UploadedMedia = {
  fileId: "a9c4e2b7-1d38-4f6a-8b05-e7c9d3f1a264",
  target: "계약서.pdf",
  localPath: "docs/계약서.pdf",
};

describe("올린 미디어 기록(S-05)", () => {
  let tempDir: string;
  let db: StateDB;
  let warn: string[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-uploaded-media-"));
    db = StateDB.open(join(tempDir, "state.db"));
    warn = [];
    setLogger({
      warn: (msg) => warn.push(msg),
      error: () => {},
      info: () => {},
      debug: () => {},
    });
  });

  afterEach(async () => {
    setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("페이지마다 적고 파일 id 로 찾는다 — 페이지 id 는 대시 유무와 상관없이 같은 페이지다", () => {
    rememberUploadedMedia(db, PAGE_ID, [IMG, DOC]);

    const known = recallUploadedMedia(db, PAGE_ID.replace(/-/g, ""));

    expect([...known.keys()]).toEqual([IMG.fileId, DOC.fileId]);
    expect(known.get(DOC.fileId)).toEqual(DOC);
    expect(recallUploadedMedia(db, "0466a570-0000-4000-8000-000000002450").size).toBe(0);
  });

  it("다시 적으면 그 페이지의 기록을 통째로 바꾼다", () => {
    rememberUploadedMedia(db, PAGE_ID, [IMG, DOC]);
    rememberUploadedMedia(db, PAGE_ID, [DOC]);

    expect([...recallUploadedMedia(db, PAGE_ID).keys()]).toEqual([DOC.fileId]);
  });

  it("적어 둔 것이 있으면 빈 목록으로 비운다 — 페이지에서 미디어가 모두 사라졌다", () => {
    rememberUploadedMedia(db, PAGE_ID, [IMG]);
    rememberUploadedMedia(db, PAGE_ID, []);

    expect(recallUploadedMedia(db, PAGE_ID).size).toBe(0);
    expect(db.getMeta(PAGE_KEY)).toBe("[]");
  });

  it("적을 것도 적어 둔 것도 없으면 쓰지 않는다 — 미디어 없는 페이지마다 줄을 만들지 않는다", () => {
    rememberUploadedMedia(db, PAGE_ID, []);

    expect(db.getMeta(PAGE_KEY)).toBeNull();
  });

  it("세 값만 적는다", () => {
    rememberUploadedMedia(db, PAGE_ID, [{ ...IMG, extra: "버린다" } as UploadedMedia]);

    expect(JSON.parse(db.getMeta(PAGE_KEY)!)).toEqual([IMG]);
  });

  it("기록을 읽지 못하면 비어 있는 것으로 보고 알린다 — 캡션으로 되찾거나 사본을 받는다", () => {
    db.setMeta(PAGE_KEY, "{깨진");

    expect(recallUploadedMedia(db, PAGE_ID).size).toBe(0);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatch(
      new RegExp(
        `^\\[Im-Nobsidian\\] 올린 미디어 기록을 읽지 못함 \\(${PAGE_ID}\\) — 캡션으로 되찾는다: `,
      ),
    );
  });

  it("모양이 틀린 줄은 건너뛴다", () => {
    db.setMeta(PAGE_KEY, JSON.stringify([{ fileId: 1 }, null, "문자열", DOC]));

    expect([...recallUploadedMedia(db, PAGE_ID).values()]).toEqual([DOC]);
  });

  it("상태 DB 가 없으면 비어 있다", () => {
    expect(recallUploadedMedia(undefined, PAGE_ID).size).toBe(0);
  });
});
