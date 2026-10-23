import { describe, it, expect, beforeEach } from "vitest";
import { PropertyMapper } from "../../src/notion/property-mapper.js";

// 실측 근거: Notion files 속성은 통째 교체(replace)라서, pull 로 로컬라이즈된
// 위키링크나 만료되는 notion-hosted 서명 URL 이 섞인 채 push 하면
// 원본 첨부가 삭제/오염된다. 보호 대상이 하나라도 있으면 속성 자체를
// 미전송(속성 보존)하는 것이 무손실이다.
describe("PropertyMapper — files push 가드", () => {
  let mapper: PropertyMapper;

  beforeEach(() => {
    mapper = new PropertyMapper();
    mapper.loadSchema({ 표지: { id: "x", type: "files" } });
  });

  it("위키링크 포함 → 속성 미전송", () => {
    const result = mapper.toNotionProperties({ 표지: "[[attachments/cover-abc123.jpg]]" }, "T");
    expect(result.표지).toBeUndefined();
  });

  it("별칭 위키링크 포함 → 속성 미전송", () => {
    const result = mapper.toNotionProperties({ 표지: "[[attachments/a.png|표지]]" }, "T");
    expect(result.표지).toBeUndefined();
  });

  it("notion-hosted 서명 URL(prod-files-secure) → 속성 미전송", () => {
    const url =
      "https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/def/cover.jpg?X-Amz-Expires=3600";
    const result = mapper.toNotionProperties({ 표지: url }, "T");
    expect(result.표지).toBeUndefined();
  });

  it("신형 file.notion.so URL → 속성 미전송", () => {
    const url = "https://file.notion.so/f/f/space/file/cover.jpg?table=block&id=x";
    const result = mapper.toNotionProperties({ 표지: url }, "T");
    expect(result.표지).toBeUndefined();
  });

  it("복수 파일 중 하나만 보호 대상이어도 통째 미전송 (부분 교체 = 나머지 삭제)", () => {
    const result = mapper.toNotionProperties(
      { 표지: ["https://cdn.x.com/ok.jpg", "[[attachments/local.png]]"] },
      "T",
    );
    expect(result.표지).toBeUndefined();
  });

  it("일반 외부 URL 만이면 정상 전송", () => {
    const result = mapper.toNotionProperties({ 표지: "https://cdn.x.com/a.jpg" }, "T");
    expect(result.표지).toEqual({
      files: [
        {
          type: "external",
          name: "https://cdn.x.com/a.jpg",
          external: { url: "https://cdn.x.com/a.jpg" },
        },
      ],
    });
  });

  it("{url} 객체 배열 형태도 가드 적용", () => {
    const result = mapper.toNotionProperties(
      { 표지: [{ name: "c", url: "https://file.notion.so/f/f/x/y/c.jpg" }] },
      "T",
    );
    expect(result.표지).toBeUndefined();
  });
});

describe("files 속성 파일 이름 — Notion 한도 100자", () => {
  const mapper = new PropertyMapper();
  mapper.loadSchema({ 첨부: { id: "x", type: "files" } });
  const names = (value: unknown) =>
    (
      mapper.toNotionProperties({ 첨부: value }, "T").첨부 as { files: { name: string }[] }
    ).files.map((f) => f.name);

  it("짧은 URL 은 예전처럼 URL 이 이름이다", () => {
    expect(names("https://example.com/a.png")).toEqual(["https://example.com/a.png"]);
  });

  it("100자를 넘는 URL 은 파일 이름으로 — 실측 120 · 165자 URL 이 페이지 생성을 통째로 막았다", () => {
    const url = `https://cdn.example.com/${"x".repeat(80)}/%ED%91%9C%EC%A7%80.jpg?token=${"t".repeat(40)}`;
    expect(url.length).toBeGreaterThan(100);
    expect(names(url)).toEqual(["표지.jpg"]);
  });

  it("파일 이름도 길면 확장자를 남기고 줄인다 — 이모지를 반으로 가르지 않는다", () => {
    const url = `https://e.com/${"😀".repeat(70)}.png`;
    const [name] = names(url);
    expect(name!.length).toBeLessThanOrEqual(100);
    expect(name!.endsWith("….png")).toBe(true);
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(names([{ name: "n".repeat(150), url: "https://e.com/a" }])[0]!.length).toBe(100);
  });

  describe("올린 볼트 첨부", () => {
    const uploads = new Map([["attachments/a.pdf", { fileUploadId: "up-1", name: "a.pdf" }]]);

    it("바뀐 값 가운데 파일 속성의 볼트 첨부만 고른다", () => {
      mapper.loadSchema({ 표지: { id: "x", type: "files" }, 링크: { id: "y", type: "rich_text" } });
      expect(
        mapper.localFileTargets({
          표지: ["[[attachments/a.pdf|별칭]]", "https://cdn.x.com/b.jpg", "[[attachments/a.pdf]]"],
          링크: "[[attachments/c.pdf]]",
        }),
      ).toEqual(["attachments/a.pdf"]);
    });

    it("올린 첨부는 그 파일로 · 외부 주소는 그대로 보낸다", () => {
      const { properties } = mapper.toNotionPropertyChanges(
        { changed: { 표지: ["[[attachments/a.pdf]]", "https://cdn.x.com/b.jpg"] }, cleared: [] },
        null,
        { uploads },
      );
      expect(properties.표지).toEqual({
        files: [
          { type: "file_upload", name: "a.pdf", file_upload: { id: "up-1" } },
          {
            type: "external",
            name: "https://cdn.x.com/b.jpg",
            external: { url: "https://cdn.x.com/b.jpg" },
          },
        ],
      });
    });

    it("못 올린 첨부나 서명 주소가 섞이면 보내지 않는다 — 남은 원격 파일이 지워지지 않게", () => {
      const send = (value: unknown) =>
        mapper.toNotionPropertyChanges({ changed: { 표지: value }, cleared: [] }, null, { uploads })
          .properties.표지;
      expect(send(["[[attachments/a.pdf]]", "[[attachments/없음.pdf]]"])).toBeUndefined();
      expect(
        send(["[[attachments/a.pdf]]", "https://file.notion.so/f/f/space/file/x.jpg?id=1"]),
      ).toBeUndefined();
    });
  });
});
