import { describe, it, expect } from "vitest";
import { EmbedResolver } from "../../src/converter/pre-processors/embed.js";
import { LocalImageRestorer } from "../../src/converter/post-processors/local-image-restorer.js";
import { PreserveMarkerInjector } from "../../src/converter/post-processors/preserve-marker-injector.js";
import type { ProcessorInput } from "../../src/types/convert.js";
import { roundtrip } from "./roundtrip-fidelity.js";

const pushContext = {
  direction: "push" as const,
  path: "markdown-api" as const,
  filePath: "test.md",
};
const pullContext = { ...pushContext, direction: "pull" as const };

function push(content: string) {
  const input: ProcessorInput = { content, metadata: {}, context: pushContext };
  return new EmbedResolver().process(input).content;
}

function pull(content: string) {
  const input: ProcessorInput = { content, metadata: {}, context: pullContext };
  return new LocalImageRestorer().process(input).content;
}

// R1: 자리표시자는 **한 줄**이어야 한다. 두 줄로 쓰면 Notion Markdown API 가 quote 를
// 두 블록으로 쪼개, 업로드 후 마커 줄만 지워지고 `📎 파일명` 줄이 미디어 옆에 유령으로
// 남는다(실측). 예전 두 줄 형태로 이미 올라간 문서를 위해 pull 복원은 양쪽을 다 받는다.
describe("비이미지 로컬 임베드 push (D5)", () => {
  it("![[*.pdf]] 를 quote+local-file 마커 쌍으로 변환한다", () => {
    expect(push("![[report.pdf]]")).toBe(
      "> 📎 report.pdf %% im-nobsidian:local-file:report.pdf %%",
    );
  });

  it("폴더 경로 임베드는 파일명만 표시하고 마커에 전체 경로를 보존한다", () => {
    // 경로는 위키링크 마커와 같이 퍼센트 인코딩해 싣는다(R3 D-PCT-MARKER).
    expect(push("![[docs/spec.pdf]]")).toBe(
      "> 📎 spec.pdf %% im-nobsidian:local-file:docs%2Fspec.pdf %%",
    );
  });

  it("이미지 임베드는 기존 local-image 마커 경로를 유지한다(회귀 가드)", () => {
    expect(push("![[img.png]]")).toBe("> 📎 img.png %% im-nobsidian:local-image:img.png %%");
  });

  /*
   * 노트 임베드는 **아무 변환도 하지 않는다**. 의사 프로토콜 링크로 바꿔 올리면 Notion 이
   * 미지원 스킴을 버리고 라벨만 남겨 `![[대상]]` 이 평문으로 영구 붕괴한다(라이브 실측, I13).
   * 원문 그대로 올리면 Notion 이 일반 텍스트로 보존하고 pull 이 글자 그대로 되돌린다.
   */
  it("노트 임베드(확장자 없음/.md/.canvas)는 원문 그대로 올라간다", () => {
    expect(push("![[다른노트]]")).toBe("![[다른노트]]");
    expect(push("![[other.md]]")).toBe("![[other.md]]");
    expect(push("![[board.canvas]]")).toBe("![[board.canvas]]");
  });

  it("노트 임베드 별칭도 원문 보존 (D-EMBEDALIAS)", () => {
    expect(push("![[다른노트|별칭]]")).toBe("![[다른노트|별칭]]");
  });
});

// S-19: v0.3.2 의 pull 은 Notion 에서 고치거나 지운 미디어의 마커를 노트에 되살렸다. 그 마커를
// 그대로 올리면 자리표시자로 읽혀 옛 파일을 한 번 더 올린다 — 임베드만 자리표시자가 된다.
describe("노트에 홀로 남은 미디어 마커 (S-19)", () => {
  it("마커만 있는 줄은 보내지 않는다 — 임베드는 그대로 자리표시자가 된다", () => {
    expect(push("![[a.png|새 설명]]\n%% im-nobsidian:local-image:a.png %%\n\n뒤 문단")).toBe(
      "> 📎 a.png %% im-nobsidian:local-image:a.png%7C%EC%83%88%20%EC%84%A4%EB%AA%85 %%\n\n\n뒤 문단",
    );
  });

  it("글 끝에 붙은 마커도 뗀다 — 마커 없는 옛 보존 기록이 줄 가운데에 넣었다", () => {
    expect(push("앞 문단%% im-nobsidian:local-file:docs%2Fspec.pdf %%")).toBe("앞 문단");
  });

  it("코드 안의 마커는 그대로 둔다 — 마커 형식을 설명하는 글이다", () => {
    const doc =
      "```\n%% im-nobsidian:local-image:a.png %%\n```\n\n`%% im-nobsidian:local-file:b.pdf %%` 형식";
    expect(push(doc)).toBe(doc);
  });

  it("볼트에 남은 자리표시자는 그대로 둔다 — 올리면 제자리 블록으로 바뀐다", () => {
    const placeholder = "> 📎 a.png %% im-nobsidian:local-image:a.png %%";
    expect(push(placeholder)).toBe(placeholder);
  });

  it("pull 은 건드리지 않는다", () => {
    const input: ProcessorInput = {
      content: "%% im-nobsidian:local-image:a.png %%",
      metadata: {},
      context: pullContext,
    };
    expect(new EmbedResolver().process(input).content).toBe(input.content);
  });
});

// S-18: 코드 안의 임베드는 임베드 문법을 보여 주는 글이다 — Obsidian 도 임베드로 그리지 않는다.
// 예전 push 는 여기도 자리표시자로 바꿔, 펜스 안이면 Notion 코드에 `> 📎 …` 가 보였고 인라인
// 코드는 둘로 쪼개져 그 사이에 자리표시자 줄이 들어갔다.
describe("코드 안의 임베드 (S-18)", () => {
  const PLACEHOLDER = "> 📎 a.png %% im-nobsidian:local-image:a.png %%";

  it("코드 펜스 안의 임베드는 그대로 올린다", () => {
    const doc = "```md\n![[a.png]]\n![[docs/spec.pdf|사본]]\n```";
    expect(push(doc)).toBe(doc);
  });

  it("인라인 코드 안의 임베드는 그대로 올린다 — 문단을 쪼개지 않는다", () => {
    const doc = "형식은 `![[b.pdf]]` 처럼 쓴다";
    expect(push(doc)).toBe(doc);
  });

  it("인라인 코드 뒤의 임베드는 자기 줄로 떼어 올린다 — 코드는 앞 문단에 남는다", () => {
    expect(push("`코드` 뒤 ![[a.png]] 끝")).toBe(`\`코드\` 뒤\n\n${PLACEHOLDER}\n\n끝`);
  });

  // 코드에 붙은 임베드는 조각의 맨 앞·맨 끝에 온다. 조각만 보고 정하면 줄머리·줄끝으로
  // 잘못 알아, 자리표시자가 코드와 한 줄에 붙어 quote 가 되지 못한다.
  it.each([
    ["바로 뒤", "`코드`![[a.png]] 끝", `\`코드\`\n\n${PLACEHOLDER}\n\n끝`],
    ["바로 앞", "앞 ![[a.png]]`코드`", `앞\n\n${PLACEHOLDER}\n\n\`코드\``],
  ])("인라인 코드 %s에 붙은 임베드도 자기 줄로 떼어 올린다", (_label, doc, expected) => {
    expect(push(doc)).toBe(expected);
  });

  it("두 문단의 홑 백틱 사이 임베드는 코드가 아니다 — 자리표시자로 올린다", () => {
    expect(push("홑 ` 하나\n\n![[a.png]]\n\n또 ` 하나")).toBe(
      `홑 \` 하나\n\n${PLACEHOLDER}\n\n또 \` 하나`,
    );
  });

  it("코드 안의 동영상 이미지 링크는 임베드 마커로 바꾸지 않는다", () => {
    const doc = "```\n![영상](https://youtu.be/abc)\n```";
    expect(push(doc)).toBe(doc);
  });

  it("코드 안의 임베드는 올릴 목록에 넣지 않는다", () => {
    const input: ProcessorInput = {
      content: "`![[a.png]]`\n\n![[b.png]]",
      metadata: {},
      context: pushContext,
    };
    expect(new EmbedResolver().process(input).metadata.images).toEqual([
      { url: "b.png", localPath: "b.png", isExternal: false },
    ]);
  });

  it.each([
    ["코드 펜스", "앞 문단\n\n```md\n![[a.png]]\n![[docs/spec.pdf|사본]]\n```\n\n뒤 문단"],
    ["인라인 코드", "형식은 `![[b.pdf]]` 처럼 쓴다\n\n![[a.png|설명]]"],
  ])("%s — 임베드가 기본 파이프라인을 오가도 그대로다", (_label, doc) => {
    const result = roundtrip(doc);
    expect(result.outputBody).toBe(result.inputBody);
  });

  // 자리표시자 형식을 설명하는 노트 — 코드 안의 같은 모양 글은 push 가 심은 것이 아니다.
  const DESCRIBED = [
    ["코드 펜스", `앞 문단\n\n\`\`\`md\n${PLACEHOLDER}\n\`\`\`\n\n뒤 문단`],
    ["인라인 코드", `자리표시자는 \`${PLACEHOLDER}\` 처럼 생겼다`],
  ];

  it.each(DESCRIBED)(
    "%s 안의 자리표시자 모양 글은 pull 이 임베드로 바꾸지 않는다",
    (_label, doc) => {
      expect(pull(doc!)).toBe(doc);
    },
  );

  it.each(DESCRIBED)(
    "%s 안의 자리표시자 모양 글이 기본 파이프라인을 오가도 그대로다",
    (_label, doc) => {
      const result = roundtrip(doc!);
      expect(result.outputBody).toBe(result.inputBody);
    },
  );
});

describe("비이미지 로컬 임베드 pull 복원 (D5)", () => {
  it("local-file 마커 쌍을 ![[경로]] 로 복원한다", () => {
    expect(pull("> 📎 spec.pdf\n> %% im-nobsidian:local-file:docs/spec.pdf %%")).toBe(
      "![[docs/spec.pdf]]",
    );
  });

  it("예전 두 줄 자리표시자도 계속 복원한다(하위호환)", () => {
    expect(pull("> 📎 spec.pdf\n> %% im-nobsidian:local-file:docs/spec.pdf %%")).toBe(
      "![[docs/spec.pdf]]",
    );
  });

  it("공백 있는 경로도 통째로 복원한다", () => {
    const original = "![[내 사진 모음/여름 휴가.png]]";
    expect(pull(push(original))).toBe(original);
  });

  it("크기 별칭이 붙은 이미지도 왕복한다", () => {
    const original = "![[assets/photo.png|300]]";
    expect(pull(push(original))).toBe(original);
  });

  it("왕복: ![[x.pdf]] → 마커 쌍 → ![[x.pdf]]", () => {
    const original = "앞 문단\n\n![[archive/백서.pdf]]\n\n뒤 문단";
    expect(pull(push(original))).toBe(original);
  });
});

// R3 D-PCT-MARKER: `%` 한 글자가 마커를 통째로 무효화해 임베드가 **사라지고** 마커
// 원문이 본문에 노출됐다(실볼트 `LLM Inference` 한 파일에서 임베드 13개 중 3개 소실).
// push 는 인코딩으로, pull 은 넓힌 캡처+복호로 — 이미 올라간 구버전 마커도 살린다.
describe("미디어 자리표시자 — 퍼센트 기호 (D-PCT-MARKER)", () => {
  it("캡션 별칭에 `%` 가 있어도 왕복한다", () => {
    const original = "![[attachments/a.png|모델의 50% 압축]]";
    expect(pull(push(original))).toBe(original);
  });

  it("괄호까지 섞인 백분율 별칭도 왕복한다", () => {
    const original = "![[attachments/a.png|50% 압축(정적의 20%)]]";
    expect(pull(push(original))).toBe(original);
  });

  it("파일명 자체에 `%` 가 있어도 왕복한다", () => {
    const original = "![[attachments/50%.png]]";
    expect(pull(push(original))).toBe(original);
  });

  it("자리표시자에 마커 원문이 남지 않는다", () => {
    expect(pull(push("![[a.png|50% 압축]]"))).not.toContain("im-nobsidian:local-image");
  });

  it("인코딩 이전 구버전 마커(원문 `%`)도 그대로 복원한다(하위호환)", () => {
    expect(pull("> 📎 50%.png %% im-nobsidian:local-image:attachments/50%.png %%")).toBe(
      "![[attachments/50%.png]]",
    );
    expect(pull("> 📎 a.png %% im-nobsidian:local-image:attachments/a.png|50% 압축 %%")).toBe(
      "![[attachments/a.png|50% 압축]]",
    );
  });
});

describe("PreserveMarkerInjector — local-file 의미 복원 판정 (D5)", () => {
  it("본문에 ![[대상]] 이 이미 있으면 local-file 마커를 재삽입하지 않는다", () => {
    const content = "본문\n![[docs/spec.pdf]]\n끝\n";
    const input: ProcessorInput = {
      content,
      metadata: {
        preserveMarkers: [
          {
            type: "local-file",
            params: { __raw: "docs/spec.pdf", __anchor: "본문" },
            startIndex: 3,
            endIndex: 3,
          },
        ],
      },
      context: pullContext,
    };
    expect(new PreserveMarkerInjector().process(input).content).toBe(content);
  });
});
