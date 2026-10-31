/**
 * 다시 잇기의 견주기(P7, ADR-049) — 받은 글에 아직 풀지 못한 Notion 링크 자리가 남아 있어도 노트의 같은 자리 링크와
 * 같다고 본다. 실측: 상태 DB 를 잃은 볼트를 받으니 `[[b]]` 를 가진 `a.md` 가 `[[notion:<id>]]` 로 받혀 충돌이 됐다.
 */
import { describe, it, expect } from "vitest";
import { sameAsPendingLinks } from "../../src/converter/notion-id-links.js";

const ID = "40a13b18d38281458391ff17ff338483";
const UUID = "40a13b18-d382-8145-8391-ff17ff338483";

describe("sameAsPendingLinks", () => {
  it("라벨 없는 자리는 노트의 위키링크 · 마크다운 링크와 같다", () => {
    const remote = `# A\n\n**굵게** 와 [[notion:${ID}]] 링크.\n`;
    expect(sameAsPendingLinks("# A\n\n**굵게** 와 [[b]] 링크.\n", remote)).toBe(true);
    expect(sameAsPendingLinks("# A\n\n**굵게** 와 [[sub/b|비]] 링크.", remote)).toBe(true);
    expect(sameAsPendingLinks("# A\n\n**굵게** 와 [b](sub/b.md) 링크.\n", remote)).toBe(true);
  });

  it("라벨이 있으면 노트 링크의 대상이나 별칭이 그 라벨이어야 한다", () => {
    const remote = `[[notion:${UUID}|비]] 로 가기`;
    expect(sameAsPendingLinks("[[비]] 로 가기", remote)).toBe(true);
    expect(sameAsPendingLinks("[[폴더/비]] 로 가기", remote)).toBe(true);
    expect(sameAsPendingLinks("[[b|비]] 로 가기", remote)).toBe(true);
    expect(sameAsPendingLinks("[비](b.md) 로 가기", remote)).toBe(true);
    expect(sameAsPendingLinks("[[다른]] 로 가기", remote)).toBe(false);
  });

  it("링크 밖의 글이 다르거나 그 자리에 링크가 없으면 다르다", () => {
    const remote = `앞 [[notion:${ID}]] 뒤`;
    expect(sameAsPendingLinks("앞 [[b]] 뒤 더", remote)).toBe(false);
    expect(sameAsPendingLinks("앞 b 뒤", remote)).toBe(false);
  });

  it("frontmatter relation 의 원시 id 는 따옴표 친 위키링크와 같다", () => {
    const remote = `---\n관련:\n  - ${UUID}\n---\n본문\n`;
    expect(sameAsPendingLinks(`---\n관련:\n  - "[[행 하나]]"\n---\n본문\n`, remote)).toBe(true);
    expect(sameAsPendingLinks(`---\n관련:\n  - 다른 값\n---\n본문\n`, remote)).toBe(false);
  });

  it("풀지 못한 자리가 없으면 견주지 않는다(false — 보통의 견주기가 맡는다)", () => {
    expect(sameAsPendingLinks("같은 글", "같은 글")).toBe(false);
  });
});
