import { describe, expect, it } from "vitest";
import { mergeRowFrontmatter } from "../../src/converter/frontmatter-merge.js";
import { FrontmatterGenerator } from "../../src/converter/post-processors/frontmatter-generator.js";
import type { ConversionContext } from "../../src/types/convert.js";
import { joinFrontmatter, splitFrontmatter } from "../../src/utils/frontmatter.js";

/** 합친 노트 — 본문은 `본문`. */
function merge(local: string, pulled: Record<string, unknown>, owned: string[] = []): string {
  const lines = mergeRowFrontmatter(local, pulled, new Set(owned));
  expect(lines).not.toBeNull();
  return joinFrontmatter(lines!, "본문\n");
}

const NOTE = [
  "---",
  "# 이 노트는 손으로 고친다",
  "aliases: [별칭]",
  'title: "과제 A"',
  "상태: 진행 중",
  "태그: [a, b] # 흐름 목록",
  "",
  "# 일정",
  "마감: 2026-10-01T10:00",
  "cssclasses:",
  "  - wide",
  "---",
  "본문",
  "",
].join("\n");

const PULLED = { title: "과제 A", 상태: "진행 중", 태그: ["a", "b"], 마감: "2026-10-01T10:00" };
const OWNED = ["상태", "태그", "마감", "마감_end", "점수", "title", "cover", "icon"];

describe("mergeRowFrontmatter — 받은 행 속성을 로컬 frontmatter 에 합친다 (F-08)", () => {
  it("값이 같으면 로컬 줄 그대로 — 따옴표 · 흐름 목록 · 주석 · 빈 줄 · 로컬에만 있는 키까지", () => {
    expect(merge(NOTE, PULLED, OWNED)).toBe(NOTE);
  });

  it("바뀐 속성만 그 자리에서 고친다 — 다른 줄은 한 글자도 바뀌지 않는다", () => {
    const out = merge(NOTE, { ...PULLED, 상태: "완료" }, OWNED);
    expect(out).toBe(NOTE.replace("상태: 진행 중", "상태: 완료"));
  });

  it("Notion 에서 비운 속성은 지우고, 그 뒤의 빈 줄 · 주석은 남긴다", () => {
    const { 태그: _drop, ...pulled } = PULLED;
    const out = merge(NOTE, pulled, OWNED);
    expect(out).toBe(NOTE.replace("태그: [a, b] # 흐름 목록\n", ""));
  });

  it("새 속성은 받은 차례에서 앞에 오는 키 바로 뒤에", () => {
    const pulled = {
      title: "과제 A",
      상태: "진행 중",
      점수: 3,
      태그: ["a", "b"],
      마감: "2026-10-01T10:00",
      마감_end: "2026-10-03T18:00",
    };
    const out = merge(NOTE, pulled, OWNED);
    expect(out).toBe(
      NOTE.replace("상태: 진행 중\n", "상태: 진행 중\n점수: 3\n").replace(
        "마감: 2026-10-01T10:00\n",
        "마감: 2026-10-01T10:00\n마감_end: 2026-10-03T18:00\n",
      ),
    );
  });

  it("받은 키가 로컬에 하나도 없으면 로컬 키 뒤에 받은 차례로", () => {
    const local = "---\naliases:\n  - 별칭\n---\n본문\n";
    expect(merge(local, { title: "T", 상태: "새" }, ["상태", "title"])).toBe(
      "---\naliases:\n  - 별칭\ntitle: T\n상태: 새\n---\n본문\n",
    );
  });

  it("맨 앞 새 키는 맨 앞 받은 키 앞에 — 첫 키 앞 주석 뒤에 놓는다", () => {
    const local = "---\n# 머리 주석\n상태: 진행\n---\n";
    expect(merge(local, { 점수: 1, 상태: "진행" }, ["점수", "상태"])).toBe(
      "---\n# 머리 주석\n점수: 1\n상태: 진행\n---\n본문\n",
    );
  });

  it("예전 모양의 날짜(`{start, end}` · 오프셋 시각)는 받은 모양으로 바꾼다", () => {
    const local = [
      "---",
      "기간:",
      "  start: 2026-10-01",
      "  end: 2026-10-03",
      "마감: '2026-10-01T10:00:00.000+09:00'",
      "메모: 그대로",
      "---",
      "",
    ].join("\n");
    const pulled = {
      기간: "2026-10-01",
      기간_end: "2026-10-03",
      마감: "2026-10-01T10:00",
      메모: "그대로",
    };
    expect(merge(local, pulled, ["기간", "기간_end", "마감", "마감_end", "메모"])).toBe(
      "---\n기간: 2026-10-01\n기간_end: 2026-10-03\n마감: 2026-10-01T10:00\n메모: 그대로\n---\n본문\n",
    );
  });

  it("YAML 이 날짜로 읽은 값과 받은 글이 같은 날짜면 같은 값이다", () => {
    const local = "---\n시작: 2026-10-01\n---\n";
    expect(merge(local, { 시작: "2026-10-01" }, ["시작"])).toBe(`${local}본문\n`);
  });

  it("여러 줄 값(블록 글 · 목록)도 같으면 줄 그대로, 다르면 그 키만 다시 적는다", () => {
    const local = [
      "---",
      "설명: |",
      "  첫 줄",
      "",
      "  셋째 줄",
      "목록:",
      "- 하나",
      "- 둘",
      "상태: a",
      "---",
      "",
    ].join("\n");
    const pulled = { 설명: "첫 줄\n\n셋째 줄\n", 목록: ["하나", "둘"], 상태: "b" };
    expect(merge(local, pulled, ["설명", "목록", "상태"])).toBe(
      local.replace("상태: a", "상태: b") + "본문\n",
    );
  });

  it("키 단위로 나눠 읽을 수 없으면 값만 합친다 — 로컬에만 있는 키 · 차례는 지킨다", () => {
    const anchors = "---\n기본: &d 진행\nalias_key: 로컬\n상태: *d\n---\n";
    const out = merge(anchors, { 상태: "완료" }, ["상태"]);
    expect(splitFrontmatter(out).data).toEqual({ 기본: "진행", alias_key: "로컬", 상태: "완료" });
    expect(Object.keys(splitFrontmatter(out).data)).toEqual(["기본", "alias_key", "상태"]);

    const crlf = "---\r\naliases: [x]\r\n상태: 진행\r\n---\r\n";
    const out2 = merge(crlf, { 상태: "완료" }, ["상태"]);
    expect(out2).toBe("---\naliases:\n  - x\n상태: 완료\n---\n본문\n");
  });

  it("로컬 노트에 frontmatter 가 없거나 읽을 수 없으면 null — 받은 대로 쓴다", () => {
    expect(mergeRowFrontmatter("본문만\n", { 상태: "a" }, new Set(["상태"]))).toBeNull();
    expect(mergeRowFrontmatter("---\n상태: [\n---\n", { 상태: "a" }, new Set(["상태"]))).toBeNull();
  });

  it("받은 속성이 모두 비고 로컬에 Notion 키뿐이면 frontmatter 를 쓰지 않는다", () => {
    const lines = mergeRowFrontmatter("---\n상태: a\n---\n", {}, new Set(["상태"]));
    expect(joinFrontmatter(lines!, "본문\n")).toBe("본문\n");
  });
});

describe("FrontmatterGenerator — 행을 받을 때만 합친다 (F-08)", () => {
  const generator = new FrontmatterGenerator();
  const pull: ConversionContext = { direction: "pull", path: "markdown-api", filePath: "r.md" };

  it("notionKeys 와 로컬 노트가 있으면 합친다", () => {
    const result = generator.process({
      content: "본문",
      metadata: {
        properties: { ...PULLED, 상태: "완료" },
        localContent: NOTE,
        notionKeys: OWNED,
      },
      context: pull,
    });
    expect(result.content).toBe(NOTE.replace("상태: 진행 중", "상태: 완료"));
  });

  it("notionKeys 가 없으면(페이지) 예전처럼 받은 속성만 적는다", () => {
    const result = generator.process({
      content: "본문",
      metadata: { properties: { 상태: "완료" }, localContent: NOTE },
      context: pull,
    });
    expect(result.content).toBe("---\n상태: 완료\n---\n본문\n");
  });

  it("로컬 노트가 없으면(새 행) 받은 속성만 적는다", () => {
    const result = generator.process({
      content: "본문",
      metadata: { properties: { 상태: "완료" }, notionKeys: ["상태"] },
      context: pull,
    });
    expect(result.content).toBe("---\n상태: 완료\n---\n본문\n");
  });
});
