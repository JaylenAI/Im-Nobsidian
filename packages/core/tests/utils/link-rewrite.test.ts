import { describe, it, expect } from "vitest";
import { rewriteLinks, type LinkRewriteContext } from "../../src/utils/link-rewrite.js";

/** 볼트 파일 목록과 바꾼 것 — 바꾼 뒤 목록은 옛 경로를 새 경로로 바꾼 것. */
function vault(files: string[], renames: Record<string, string>): LinkRewriteContext {
  const map = new Map(Object.entries(renames));
  return {
    before: new Set(files),
    after: new Set(files.map((file) => map.get(file) ?? file)),
    renames: map,
  };
}

const at = (path: string) => ({ from: path, to: path });

describe("rewriteLinks", () => {
  const files = ["A/old.md", "B/note.md", "img/p.png", "C/other.md"];
  const ctx = vault(files, { "A/old.md": "A/new.md" });

  it("이름 꼴 위키링크 · 임베드 · 제목 · 별칭 · 표 안의 별칭", () => {
    const text = "[[old]] ![[old]] [[old#H|보기]] | [[old\\|표]] | [[old.md]]";
    expect(rewriteLinks(text, at("B/note.md"), ctx)).toBe(
      "[[new]] ![[new]] [[new#H|보기]] | [[new\\|표]] | [[new.md]]",
    );
  });

  it("경로 꼴은 새 경로, 다른 파일 링크와 코드 안은 그대로", () => {
    const text = "[[A/old]] [[other]] `[[old]]`\n```\n[[old]]\n```\n";
    expect(rewriteLinks(text, at("B/note.md"), ctx)).toBe(
      "[[A/new]] [[other]] `[[old]]`\n```\n[[old]]\n```\n",
    );
  });

  it("마크다운 링크 — 상대 · 볼트 경로 · %20 · <> · 바깥 주소는 그대로", () => {
    const spaced = vault(["A/my old.md", "B/note.md"], { "A/my old.md": "A/my new.md" });
    const text =
      "[a](../A/my%20old.md#h) [b](<A/my old.md>) [c](https://x.y/A/my%20old.md) [d](#h)";
    expect(rewriteLinks(text, at("B/note.md"), spaced)).toBe(
      "[a](../A/my%20new.md#h) [b](<A/my new.md>) [c](https://x.y/A/my%20old.md) [d](#h)",
    );
  });

  it("새 이름이 볼트에 또 있으면 경로로 적는다", () => {
    const twin = vault(["A/old.md", "C/new.md", "B/note.md"], { "A/old.md": "A/new.md" });
    expect(rewriteLinks("[[old]]", at("B/note.md"), twin)).toBe("[[A/new]]");
  });

  it("같은 이름이 여럿이면 노트 폴더의 것 — 그것도 없으면 두지 않는다", () => {
    const dup = vault(["A/old.md", "B/old.md", "B/note.md", "C/n.md"], { "A/old.md": "A/x.md" });
    expect(rewriteLinks("[[old]]", at("B/note.md"), dup)).toBe("[[old]]");
    expect(rewriteLinks("[[old]]", at("C/n.md"), dup)).toBe("[[old]]");
    // A 폴더의 노트에게 [[old]] 는 A/old.md 다
    expect(rewriteLinks("[[old]]", at("A/y.md"), dup)).toBe("[[x]]");
  });

  it("폴더를 옮기면 안의 파일을 가리키던 경로 꼴 링크와 첨부를 고친다 — 이름 꼴은 그대로", () => {
    const moved = vault(["P/a.md", "P/img.png", "n.md"], {
      "P/a.md": "Q/P/a.md",
      "P/img.png": "Q/P/img.png",
    });
    expect(rewriteLinks("[[P/a]] [[a]] ![[P/img.png]] ![[img.png]]", at("n.md"), moved)).toBe(
      "[[Q/P/a]] [[a]] ![[Q/P/img.png]] ![[img.png]]",
    );
  });

  it("옮긴 노트 안의 상대 링크는 새 자리 기준으로 다시 적는다", () => {
    const moved = vault(["P/a.md", "x.md"], { "P/a.md": "Q/R/a.md" });
    expect(
      rewriteLinks("[x](../x.md) [y](./b.md)", { from: "P/a.md", to: "Q/R/a.md" }, moved),
    ).toBe("[x](../../x.md) [y](./b.md)");
  });

  it("frontmatter 의 링크도 고친다", () => {
    expect(rewriteLinks('---\nrelated: "[[old]]"\n---\n본문', at("B/note.md"), ctx)).toBe(
      '---\nrelated: "[[new]]"\n---\n본문',
    );
  });

  it("고칠 것이 없으면 글을 그대로 돌려준다", () => {
    const text = "[[other]] 그냥 글";
    expect(rewriteLinks(text, at("B/note.md"), ctx)).toBe(text);
  });
});
