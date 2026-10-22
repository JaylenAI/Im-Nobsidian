import { describe, it, expect } from "vitest";
import { fileUrlOfBlock, notionFileIdOf } from "../../src/utils/notion-file-url.js";

/**
 * S-05 — Notion 이 저장한 파일의 id. 서명(쿼리)은 받을 때마다 바뀌어도 id 는 그대로라, push 가
 * 올린 블록을 pull 이 알아보는 열쇠다.
 */
const SPACE_ID = "5d2f8a41-3c7e-4b19-9e0a-7f6d2c1b8a93";
const FILE_ID = "0f5a3c1e-7b2d-4e8f-9a61-3c2b1d0e9f87";

describe("notionFileIdOf", () => {
  it.each([
    [
      "prod-files-secure 서명 URL",
      `https://prod-files-secure.s3.us-west-2.amazonaws.com/${SPACE_ID}/${FILE_ID}/t-img.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc`,
    ],
    [
      "file.notion.so 신형 URL",
      `https://file.notion.so/f/f/${SPACE_ID}/${FILE_ID}/%EC%82%AC%EC%A7%84.png?table=block&id=blk&expirationTimestamp=1`,
    ],
    [
      "옛 secure.notion-static.com URL",
      `https://s3.us-west-2.amazonaws.com/secure.notion-static.com/${FILE_ID}/a.pdf`,
    ],
    [
      "대문자 id",
      `https://prod-files-secure.s3.us-west-2.amazonaws.com/${SPACE_ID}/${FILE_ID.toUpperCase()}/a.png`,
    ],
  ])("%s 에서 id 를 읽는다(소문자)", (_label, url) => {
    expect(notionFileIdOf(url)).toBe(FILE_ID);
  });

  it("markdown API 의 내부 참조(`file://`)에서 id 를 읽는다", () => {
    const internal =
      "file://" +
      encodeURIComponent(
        JSON.stringify({
          source: `attachment:${FILE_ID}:계약서.pdf`,
          permissionRecord: { table: "block", id: "blk-1", spaceId: SPACE_ID },
        }),
      );

    expect(notionFileIdOf(internal)).toBe(FILE_ID);
  });

  it.each([
    ["Notion 이 호스팅하지 않은 URL", `https://example.com/${SPACE_ID}/${FILE_ID}/a.png`],
    ["파일 id 자리가 비어 있는 URL", "https://prod-files-secure.s3.us-west-2.amazonaws.com/a.png"],
    [
      "파일 id 자리가 UUID 가 아닌 URL",
      "https://prod-files-secure.s3.us-west-2.amazonaws.com/x/y/a.png",
    ],
    ["깨진 내부 참조", "file://%7B%22source%22"],
    ["attachment 가 아닌 내부 참조", `file://${encodeURIComponent('{"source":"https://x"}')}`],
    ["URL 이 아닌 문자열", "prod-files-secure 가 들어간 글"],
  ])("%s 는 null", (_label, url) => {
    expect(notionFileIdOf(url)).toBeNull();
  });
});

describe("fileUrlOfBlock", () => {
  it("Notion 에 저장된 파일의 URL", () => {
    expect(
      fileUrlOfBlock({ type: "image", image: { type: "file", file: { url: "u1" } } } as never),
    ).toBe("u1");
  });

  it("외부 파일의 URL", () => {
    expect(
      fileUrlOfBlock({ type: "pdf", pdf: { type: "external", external: { url: "u2" } } } as never),
    ).toBe("u2");
  });

  it.each([
    ["URL 이 아직 없는 업로드", { type: "file", file: { type: "file_upload", file_upload: {} } }],
    ["미디어가 아닌 블록", { type: "paragraph", paragraph: { rich_text: [] } }],
    ["type 이 없는 부분 블록", { id: "blk", object: "block" }],
  ])("%s 는 null", (_label, block) => {
    expect(fileUrlOfBlock(block as never)).toBeNull();
  });
});
