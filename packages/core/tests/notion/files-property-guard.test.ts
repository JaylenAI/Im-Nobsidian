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
