import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  frontmatterLines,
  joinFrontmatter,
  parseFrontmatter,
  plainFrontmatterValue,
  replaceFrontmatterLines,
  sameFrontmatterValue,
  splitFrontmatter,
  stringifyFrontmatter,
} from "../../src/utils/frontmatter.js";

describe("stringifyFrontmatter", () => {
  it("본문이 --- 로 시작해도 프론트매터를 생성한다(객체형 호출 봉인)", () => {
    const out = stringifyFrontmatter("---\n\n구획 본문", { title: "T" });
    expect(out.startsWith("---\ntitle: T\n---\n")).toBe(true);
    expect(out).toContain("구획 본문");
  });

  it("ISO 날짜 값의 작은따옴표를 제거한다(D3)", () => {
    const out = stringifyFrontmatter("본문", {
      created: "2026-07-14",
      updated: "2026-07-01",
    });
    expect(out).toContain("created: 2026-07-14\n");
    expect(out).toContain("updated: 2026-07-01\n");
    expect(out).not.toContain("'2026-07-14'");
  });

  it("본문 속 따옴표 날짜는 건드리지 않는다", () => {
    const body = "본문 키: '2026-07-14'";
    const out = stringifyFrontmatter(body, { created: "2026-07-14" });
    expect(out).toContain("본문 키: '2026-07-14'");
    expect(out).toContain("created: 2026-07-14\n");
  });

  it("date-only 가 아닌 값(datetime 등)의 따옴표는 유지한다", () => {
    const out = stringifyFrontmatter("본문", { at: "2026-07-14T09:00:00" });
    expect(out).toContain("'2026-07-14T09:00:00'");
  });

  it("초가 없는 날짜시각(Obsidian 날짜시각 속성)은 따옴표 없이 적고, 다시 읽어도 같은 글이다 (F-08)", () => {
    const data = { at: "2026-07-14T09:30", end: "2026-07-14T18:00", sec: "2026-07-14T09:30:15" };
    const out = stringifyFrontmatter("본문", data);
    expect(out).toBe(
      "---\nat: 2026-07-14T09:30\nend: 2026-07-14T18:00\nsec: '2026-07-14T09:30:15'\n---\n본문\n",
    );
    expect(splitFrontmatter(out).data).toEqual(data);
  });

  describe("BMP 밖 문자(이모지)를 이스케이프하지 않고 그대로 적는다(F-i)", () => {
    it("값 · 키 · 목록 · 중첩 객체의 이모지를 Obsidian 처럼 적는다", () => {
      const out = stringifyFrontmatter("본문", {
        icon: "🚀",
        "실천 ✅": "매일 🏃 달리기",
        "🧘 명상": "매일",
        tags: ["🌱", "a🌱b"],
        nested: { mood: "😀" },
      });
      expect(out).not.toMatch(/\\U|\\u[dD]/);
      expect(out).toContain("icon: 🚀\n");
      expect(out).toContain("실천 ✅: 매일 🏃 달리기\n");
      expect(out).toContain("🧘 명상: 매일\n");
      expect(out).toContain("  - 🌱\n");
      expect(out).toContain("  mood: 😀\n");
    });

    it("따옴표가 필요한 값은 이모지가 있어도 따옴표를 둔다 — 읽으면 같은 값이다", () => {
      const data = {
        colon: "🚀: 발사",
        hash: "# 🚀",
        lead: " 🚀",
        number: "12",
        mixed: "🚀\n둘째 줄",
      };
      const out = stringifyFrontmatter("본문", data);
      expect(out).not.toMatch(/\\U|\\u[dD]/);
      expect(parseFrontmatter(out).data).toEqual(data);
    });

    it("사용 영역 문자가 이미 있어도 섞지 않는다 · 본문은 건드리지 않는다", () => {
      const pua = String.fromCharCode(0xe000);
      const body = `본문 ${pua} 🚀 \\U0001F680`;
      const data = { a: `${pua}🚀`, b: "🚀🎉", c: String.fromCharCode(0xe001) };
      const out = stringifyFrontmatter(body, data);
      expect(parseFrontmatter(out).data).toEqual(data);
      expect(out.endsWith(`${body}\n`)).toBe(true);

      // 바꿀 문자로 고른 사용 영역 문자가 본문에만 있다 — 본문의 것은 되돌리지 않는다
      const onlyInBody = stringifyFrontmatter(`본문 ${pua}`, { icon: "🚀" });
      expect(onlyInBody).toBe(`---\nicon: 🚀\n---\n본문 ${pua}\n`);
    });

    it("적은 글을 다시 읽어 다시 적으면 같은 글이다", () => {
      const once = stringifyFrontmatter("본문", { icon: "🚀", 설명문구: "✨ 새로 🚀" });
      const { data, body } = parseFrontmatter(once);
      expect(stringifyFrontmatter(body, data)).toBe(once);
    });
  });
});

describe("frontmatterLines · joinFrontmatter — 줄 단위로 합칠 때 (F-08)", () => {
  it("stringifyFrontmatter 와 같은 규칙의 YAML 줄 · 같은 모양의 노트", () => {
    const data = { title: "T", 목록: ["a", "b"], at: "2026-07-14T09:30", icon: "🚀" };
    const lines = frontmatterLines(data);
    expect(lines).toEqual([
      "title: T",
      "목록:",
      "  - a",
      "  - b",
      "at: 2026-07-14T09:30",
      "icon: 🚀",
    ]);
    expect(joinFrontmatter(lines, "본문")).toBe(stringifyFrontmatter("본문", data));
    expect(frontmatterLines({})).toEqual([]);
  });

  it("살린 빈 줄 · 주석은 그대로 · 빈 줄뿐이면 본문만", () => {
    expect(joinFrontmatter(["# 주석", "a: 1", ""], "본문\n")).toBe(
      "---\n# 주석\na: 1\n\n---\n본문\n",
    );
    expect(joinFrontmatter(["", "  "], "본문")).toBe("본문\n");
    expect(joinFrontmatter([], "")).toBe("\n");
  });
});

describe("replaceFrontmatterLines — 있는 노트의 frontmatter 만 고쳐 쓸 때 (F-08)", () => {
  it("여닫는 줄 사이만 바꾼다 — 본문의 구분선 · 끝 공백 · 끝 줄바꿈 없음은 그대로", () => {
    const note = "---\na: 1\nb: 2\n---\n---\n본문  \n\n\n끝";
    expect(replaceFrontmatterLines(note, ["a: 1", "b: 3"])).toBe(
      "---\na: 1\nb: 3\n---\n---\n본문  \n\n\n끝",
    );
    expect(replaceFrontmatterLines("---\na: 1\n---", ["a: 2"])).toBe("---\na: 2\n---");
  });

  it("빈 frontmatter 에도 줄을 넣고 · 맨 앞 BOM 은 남긴다", () => {
    expect(replaceFrontmatterLines("---\n---\n본문\n", ["a: 1"])).toBe("---\na: 1\n---\n본문\n");
    expect(replaceFrontmatterLines("\ufeff---\na: 1\n---\n본문", ["a: 2"])).toBe(
      "\ufeff---\na: 2\n---\n본문",
    );
  });

  it("frontmatter 줄이 CRLF 면 바꾼 줄도 CRLF 로 — 여닫는 줄만 CRLF 면 LF 그대로", () => {
    expect(replaceFrontmatterLines("---\r\na: 1\r\n---\r\n본문\r\n", ["a: 2", "b: 3"])).toBe(
      "---\r\na: 2\r\nb: 3\r\n---\r\n본문\r\n",
    );
    expect(replaceFrontmatterLines("---\r\na: 1\n---\r\n본문", ["a: 2"])).toBe(
      "---\r\na: 2\n---\r\n본문",
    );
    expect(replaceFrontmatterLines("---\r\na: 1\r\n---\r\n", ["a: 2\r"])).toBe(
      "---\r\na: 2\r\n---\r\n",
    );
  });

  it("frontmatter 로 시작하지 않으면 null — splitFrontmatter 와 같은 여닫는 줄", () => {
    expect(replaceFrontmatterLines("본문", ["a: 1"])).toBeNull();
    expect(replaceFrontmatterLines("---\na: 1\n본문", ["a: 2"])).toBeNull();
    expect(replaceFrontmatterLines("---js\na: 1\n---\n", ["a: 2"])).toBeNull();
    expect(replaceFrontmatterLines("---\na: 1\n---x\n", ["a: 2"])).toBeNull();
  });
});

describe("plainFrontmatterValue — YAML 이 만든 Date 를 pull 이 적는 평문으로", () => {
  it("자정 Date 는 날짜만, 시각이 있으면 ISO 전체", () => {
    expect(plainFrontmatterValue(new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-10-01");
    expect(plainFrontmatterValue(new Date("2026-10-01T09:30:00.000Z"))).toBe(
      "2026-10-01T09:30:00.000Z",
    );
  });

  it("배열 · 객체 안의 Date 도 바꾸고, 나머지 값은 그대로 둔다", () => {
    expect(
      plainFrontmatterValue({
        기간: { start: new Date("2026-10-01T00:00:00.000Z"), end: null },
        목록: [new Date("2026-10-02T00:00:00.000Z"), 3, "글"],
      }),
    ).toEqual({ 기간: { start: "2026-10-01", end: null }, 목록: ["2026-10-02", 3, "글"] });
  });

  it("잘못된 Date 는 던지지 않고 글로", () => {
    expect(plainFrontmatterValue(new Date("nope"))).toBe("Invalid Date");
  });
});

describe("sameFrontmatterValue — frontmatter 값이 같은가", () => {
  it("YAML 이 읽은 Date 는 적힌 글자와 같다", () => {
    expect(sameFrontmatterValue(new Date("2026-10-01T00:00:00.000Z"), "2026-10-01")).toBe(true);
    expect(sameFrontmatterValue(new Date("2026-10-01T09:30:00.000Z"), "2026-10-01T18:30")).toBe(
      false,
    );
  });

  it("객체는 키 차례를 보지 않고 안쪽까지, 목록은 차례대로", () => {
    expect(sameFrontmatterValue({ start: "a", end: "b" }, { end: "b", start: "a" })).toBe(true);
    expect(sameFrontmatterValue({ start: "a" }, { start: "a", end: null })).toBe(false);
    expect(sameFrontmatterValue(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("글 · 수 · null 은 엄격히 — 빈 값끼리도 모양이 다르면 다르다", () => {
    expect(sameFrontmatterValue("1", 1)).toBe(false);
    expect(sameFrontmatterValue(null, undefined)).toBe(false);
    expect(sameFrontmatterValue(null, [])).toBe(false);
  });
});

describe("parseFrontmatter", () => {
  it("frontmatter 와 앞뒤 공백을 걷은 본문을 가른다", () => {
    expect(parseFrontmatter("---\n진척: 0.5\n---\n\n본문\n")).toEqual({
      data: { 진척: 0.5 },
      body: "본문",
    });
  });

  it("깨진 YAML 은 몇 번을 불러도 던진다 — gray-matter 캐시가 «속성 없음» 으로 바꾸지 않게", () => {
    const broken = "---\ntitle: T\n진척: [0.5\n---\n본문\n";
    // 파이프라인(FrontmatterExtractor)처럼 캐시를 쓰는 호출이 먼저 실패해도
    expect(() => matter(broken)).toThrow();
    expect(() => parseFrontmatter(broken)).toThrow();
    expect(() => parseFrontmatter(broken)).toThrow();
  });

  it("돌려준 값을 고쳐도 다음 호출에 새지 않는다", () => {
    const text = "---\n태그: [a]\n---\n본문\n";
    (parseFrontmatter(text).data.태그 as string[]).push("b");
    expect(parseFrontmatter(text).data.태그).toEqual(["a"]);
  });
});

describe("splitFrontmatter — Obsidian 과 같은 줄에서 여닫고, 키-값만 frontmatter 다", () => {
  const body = (text: string) => ({ data: {}, content: text, hasFrontmatter: false });

  it("frontmatter 와 본문을 가르고 본문의 앞뒤 공백을 그대로 둔다", () => {
    expect(splitFrontmatter("---\ntitle: T\n진척: 0.5\n---\n\n본문\n")).toEqual({
      data: { title: "T", 진척: 0.5 },
      content: "\n본문\n",
      hasFrontmatter: true,
    });
  });

  it("빈 frontmatter 도 frontmatter 다", () => {
    expect(splitFrontmatter("---\n---\n본문")).toEqual({
      data: {},
      content: "본문",
      hasFrontmatter: true,
    });
  });

  it("CRLF · 맨 앞 BOM 도 같게 읽는다", () => {
    expect(splitFrontmatter("\ufeff---\r\ntitle: T\r\n---\r\n본문\r\n")).toEqual({
      data: { title: "T" },
      content: "본문\r\n",
      hasFrontmatter: true,
    });
  });

  it("구분선 · 목록 · 구분선으로 시작하는 본문은 본문이다 — gray-matter 는 목록을 속성으로 뺀다", () => {
    const text = "---\n## 개요\n- 항목 하나\n- 항목 둘\n---\n\n끝 문단\n";
    expect(matter(text, {}).data).toEqual(["항목 하나", "항목 둘"]);
    expect(splitFrontmatter(text)).toEqual(body(text));
  });

  it("닫는 줄이 없는 구분선은 본문이다 — gray-matter 는 본문 전체를 속성으로 뺀다", () => {
    const text = "---\n\n첫 문단\n\n둘째 문단\n";
    expect(matter(text, {}).content).toBe("");
    expect(splitFrontmatter(text)).toEqual(body(text));
  });

  it("구분선 사이의 글 한 줄도 본문이다", () => {
    const text = "---\n\n글 한 줄\n\n---\n\n뒤\n";
    expect(splitFrontmatter(text)).toEqual(body(text));
  });

  it("첫 줄이 `---js` 면 frontmatter 가 아니고, 그 사이를 실행하지 않는다", () => {
    const probe = "__frontmatterEvalProbe";
    const text = `---js\nglobalThis.${probe} = 1\n---\n본문\n`;
    expect(splitFrontmatter(text)).toEqual(body(text));
    expect(splitFrontmatter(`---javascript\nglobalThis.${probe} = 1\n---\n`).hasFrontmatter).toBe(
      false,
    );
    expect((globalThis as Record<string, unknown>)[probe]).toBeUndefined();
  });

  it("여는 줄 · 닫는 줄은 `---` 뿐이어야 한다", () => {
    for (const text of [
      "----\ntitle: T\n---\n",
      "--- \ntitle: T\n---\n",
      "---yaml\ntitle: T\n---\n",
      "---\ntitle: T\n----\n",
      "---\ntitle: T\n--- 끝\n",
      "---\ntitle: T\n",
      "본문\n---\ntitle: T\n---\n",
    ]) {
      expect(splitFrontmatter(text), JSON.stringify(text)).toEqual(body(text));
    }
  });

  it("날짜 하나만 있는 YAML 은 키-값이 아니다 · null 은 빈 frontmatter 다(gray-matter 와 같다)", () => {
    expect(splitFrontmatter("---\n2026-09-28\n---\n").hasFrontmatter).toBe(false);
    expect(splitFrontmatter("---\n~\n---\n본문")).toEqual({
      data: {},
      content: "본문",
      hasFrontmatter: true,
    });
  });

  it("frontmatter 가 없는 노트는 그대로", () => {
    expect(splitFrontmatter("본문만\n")).toEqual(body("본문만\n"));
    expect(splitFrontmatter("")).toEqual(body(""));
  });

  it("깨진 YAML 은 캐시를 쓰는 호출 뒤에도 몇 번이고 던진다(S-13)", () => {
    // 위 parseFrontmatter 시험과 다른 글 — gray-matter 캐시는 시험 파일 안에서도 남는다
    const broken = "---\ntitle: T\n진척: [0.6\n---\n본문\n";
    expect(() => matter(broken)).toThrow();
    expect(() => matter(broken)).not.toThrow();
    expect(() => splitFrontmatter(broken)).toThrow();
    expect(() => splitFrontmatter(broken)).toThrow();
  });

  it("gray-matter 로 frontmatter 를 읽는 곳은 이 모듈 하나다", () => {
    const src = join(__dirname, "../../src");
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith(".ts")
            ? [join(dir, e.name)]
            : [],
      );
    })(src);
    const importers = files
      .filter((f) => /from\s+["']gray-matter["']/.test(readFileSync(f, "utf-8")))
      .map((f) => relative(src, f));
    expect(importers).toEqual(["utils/frontmatter.ts"]);
  });
});
