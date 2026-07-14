import { describe, it, expect } from "vitest";
import { scanMarkdownLinks, toWikilinkAlias } from "../../src/sync/image-handler.js";

/**
 * F14 재발 방지 — `[^\]]*` 류 정규식은 캡션 속 `[링크](url)` 의 첫 `]` 에서 라벨을
 * 끊어 캡션 내부 URL 을 이미지 URL 로 오인했다. 괄호 균형 스캐너의 계약을 고정한다.
 */
describe("scanMarkdownLinks", () => {
  it("단순 링크·임베드 구분", () => {
    const spans = scanMarkdownLinks("[문서](https://a.com) 와 ![그림](https://b.com/i.png)");
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ label: "문서", url: "https://a.com", isEmbed: false });
    expect(spans[1]).toMatchObject({ label: "그림", url: "https://b.com/i.png", isEmbed: true });
  });

  it("F14 핵심: 캡션 속 중첩 링크를 라벨로 온전히 취급", () => {
    const md = "![캡션에 [링크](https://arxiv.org/abs/1) 포함](https://prod-files.example/img.png)";
    const spans = scanMarkdownLinks(md);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.label).toBe("캡션에 [링크](https://arxiv.org/abs/1) 포함");
    expect(spans[0]!.url).toBe("https://prod-files.example/img.png");
    expect(spans[0]!.full).toBe(md);
  });

  it("URL 속 괄호(위키피디아류)를 균형 스캔으로 수용", () => {
    const md = "[문서](https://en.wikipedia.org/wiki/A_(b))";
    const spans = scanMarkdownLinks(md);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.url).toBe("https://en.wikipedia.org/wiki/A_(b)");
  });

  it("이스케이프된 \\[ 는 링크 시작이 아님", () => {
    expect(scanMarkdownLinks("\\[라벨](url)")).toHaveLength(0);
  });

  it("빈 줄을 가로지르는 대괄호는 링크가 아님", () => {
    expect(scanMarkdownLinks("[줄1\n\n줄2](url)")).toHaveLength(0);
  });

  it("URL 중간 개행은 링크가 아님", () => {
    expect(scanMarkdownLinks("[라벨](https://a\n.com)")).toHaveLength(0);
  });

  it("괄호 없는 대괄호(위키링크 등)는 무시", () => {
    expect(scanMarkdownLinks("[[위키링크]] 텍스트 [단독대괄호]")).toHaveLength(0);
  });
});

describe("toWikilinkAlias", () => {
  it("캡션 속 md 링크를 라벨 평문으로 평탄화", () => {
    expect(toWikilinkAlias("캡션에 [링크](https://arxiv.org) 포함")).toBe("캡션에 링크 포함");
  });

  it("위키링크는 표시명으로", () => {
    expect(toWikilinkAlias("참고 [[문서|표시명]]")).toBe("참고 표시명");
    expect(toWikilinkAlias("참고 [[문서]]")).toBe("참고 문서");
  });

  it("파이프는 하이픈으로 (별칭 구분자 충돌 방지)", () => {
    expect(toWikilinkAlias("a|b")).toBe("a-b");
  });

  it("개행은 공백으로", () => {
    expect(toWikilinkAlias("줄1\n줄2")).toBe("줄1 줄2");
  });

  it("잔여 ]] 는 ) 로 치환 (임베드 조기 종료 방지)", () => {
    expect(toWikilinkAlias("텍스트]]꼬리")).toBe("텍스트)꼬리");
  });
});
