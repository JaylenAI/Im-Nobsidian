import { describe, it, expect } from "vitest";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import {
  obsidianToNotionEnhanced,
  notionEnhancedToObsidian,
} from "../../src/converter/enhanced-md-converter.js";
import { resolveNotionIdWikilinks } from "../../src/converter/notion-id-links.js";
import type { PreserveMarker, WikilinkEntry } from "../../src/types/convert.js";

/**
 * R2 — 링크·임베드 충실도.
 *
 * 실볼트 감사에서 나온 손상 4종을 **실제 파이프라인**(createDefaultPipeline) 왕복으로 고정한다.
 *  - D-BRACKET   : 중첩 대괄호가 엉뚱한 대상을 만들고, 글자 뒤에 붙은 임베드가 유실된다
 *  - D-WIKIPAREN : 괄호가 든 제목이 마커 URL 경계를 무너뜨려 링크 문법째 깨진다
 *  - D-ALIAS-LOST: 해소된 위키링크의 별칭이 Notion mention 에 실리지 못해 사라진다
 *  - D-EMBEDALIAS: 별칭 붙은 임베드가 업로드 대상(images)에서 빠진다
 *
 * `new ConversionPipeline()` 은 프로세서가 하나도 안 붙은 빈 껍데기라 무엇을 넣어도
 * 그대로 통과한다 — 그걸로 짠 테스트는 전부 초록이면서 아무것도 검증하지 않는다(실측).
 */

const TARGET_ID = "3aa13b18-d382-8184-9a76-f495d0a9a613";
const TARGET_ID_NOHYPH = TARGET_ID.replace(/-/g, "");

/** 볼트에 실재하는 노트만 해소하는 리졸버 — 실제 push 의 해소/미해소 분기를 재현한다. */
const VAULT: Record<string, string> = { "T2-target": "__e2e_probe__/T2-target.md" };
function resolver(text: string): WikilinkEntry | null {
  return VAULT[text] ? { notionPageId: TARGET_ID, title: text } : null;
}

const plain = createDefaultPipeline();
const linked = createDefaultPipeline({ wikilinkResolver: resolver });

/** push 파이프라인 + enhanced 변환까지, 즉 Notion 에 실제로 넘어가는 문자열. */
function toNotion(input: string, pipeline = plain): string {
  return obsidianToNotionEnhanced(
    pipeline.convertToNotion(input, { direction: "push", path: "t.md" }).content,
  );
}

/**
 * Notion 저장본 → 옵시디언. 오케스트레이터와 같은 순서(enhanced → id 역조회 → 파이프라인).
 * 보존 마커는 pull 시 본문이 아니라 상태 DB 에서 온다(orchestrator.ts getPreserveMarkers).
 */
function backToObsidian(notion: string, pipeline = plain, markers?: PreserveMarker[]): string {
  const restored = resolveNotionIdWikilinks(notionEnhancedToObsidian(notion), (id) =>
    id === TARGET_ID_NOHYPH ? VAULT["T2-target"]! : null,
  ).markdown;
  return pipeline
    .convertToMarkdown(
      restored,
      { direction: "pull", path: "markdown-api", filePath: "t.md" },
      { properties: {}, ...(markers ? { preserveMarkers: markers } : {}) },
    )
    .trim();
}

function roundtrip(input: string, pipeline = plain): string {
  return backToObsidian(toNotion(input, pipeline), pipeline);
}

describe("D-BRACKET — 대괄호가 링크·임베드를 삼키지 않는다", () => {
  // 볼트 1181건 / 13파일. 감정 태그(`[[happy]]`)를 대괄호로 한 번 더 감싼 노트들.
  it("중첩 대괄호 위키링크는 안쪽 링크만 잡는다", () => {
    // 대상이 `[happy` 로 잡히면 존재하지 않는 페이지를 가리키고 `]` 하나가 링크 밖으로 샌다.
    expect(toNotion("[[[happy]]]")).toBe("[[[happy]]]");
    expect(roundtrip("[[[happy]]]")).toBe("[[[happy]]]");
  });

  it("중첩 대괄호 임베드가 원형을 유지한다", () => {
    expect(roundtrip("![[[happy]]]")).toBe("![[[happy]]]");
  });

  // 최악 사례: quote 자리표시자가 문장 한가운데 박혀 quote 가 아니게 되고,
  // 교체 대상 블록이 없어 이미지가 끝내 안 올라간다(볼트 806건 / 26파일).
  it("글자 뒤에 붙은 임베드 자리표시자는 빈 줄로 격리된다", () => {
    const notion = toNotion("느낌표 뒤![[neutral.png]] 주의.");

    // 빈 줄이 아니라 줄바꿈 하나만 두면 lazy continuation 이 `주의.` 를 quote 안으로
    // 빨아들이고, 업로드 뒤 quote→image 교체 때 그 글자가 통째로 지워진다(실 Notion 실측).
    //
    // 뒷줄의 선행 공백까지 반드시 버려야 한다 — Notion Markdown API 는 quote 다음
    // 문단이 공백으로 시작하면 그 문단을 quote 의 **자식**으로 중첩시키고, 그러면
    // deleteBlock(quote) 이 자식째 날려 `주의.` 가 또 사라진다(실 Notion 실측).
    expect(notion).toBe(
      "느낌표 뒤\n\n> 📎 neutral.png %% im-nobsidian:local-image:neutral.png %%\n\n주의.",
    );
  });

  it("격리된 자리표시자 뒤 줄이 공백으로 시작하지 않는다", () => {
    // 줄머리 공백 = Notion 이 quote 자식으로 삼는 신호. 어떤 임베드에서도 나오면 안 된다.
    const notion = toNotion("앞 ![[a.png]] 중간 ![[b.png]] 뒤");

    expect(notion.split("\n").filter((l) => /^[ \t]/.test(l))).toEqual([]);
  });

  it("앞뒤 글자를 한 자도 잃지 않는다", () => {
    const out = roundtrip("느낌표 뒤![[neutral.png]] 주의.");

    expect(out).toContain("느낌표 뒤");
    expect(out).toContain("![[neutral.png]]");
    expect(out).toContain("주의.");
  });

  it("이미 줄 단독인 임베드는 빈 줄이 늘지 않는다(멱등)", () => {
    expect(toNotion("![[neutral.png]]")).toBe(
      "> 📎 neutral.png %% im-nobsidian:local-image:neutral.png %%",
    );
  });

  it("링크 대상 밖의 대괄호는 링크로 오인되지 않는다", () => {
    const out = roundtrip("본문 [[정상 링크]] 와 [대괄호] 텍스트.");

    expect(out).toContain("[[정상 링크]]");
    expect(out).toContain("[대괄호]");
  });
});

describe("D-ESCBRACKET — Notion 이 붙여 보내는 대괄호 escape 를 되돌린다", () => {
  /**
   * 아래 입력은 전부 실 Notion `retrieveMarkdown` 원문이다.
   * push 산출물을 그대로 되먹이는 왕복 테스트는 **이 escape 단계를 건너뛰기 때문에**
   * 결함이 살아 있어도 초록이 난다 — 실볼트 왕복에서 뒤늦게 드러났다(실측).
   */
  it("중첩 escape 대괄호가 원형으로 돌아온다", () => {
    // 위키링크 패턴만 푸는 구현은 안쪽 한 쌍만 잡아 `[[\[happy]]\]` 를 남겼다.
    expect(backToObsidian("중첩 대괄호: \\[\\[\\[happy\\]\\]\\]")).toBe("중첩 대괄호: [[[happy]]]");
  });

  it("escape 된 중첩 임베드도 원형으로 돌아온다", () => {
    expect(backToObsidian("임베드 중첩: !\\[\\[\\[happy\\]\\]\\]")).toBe(
      "임베드 중첩: ![[[happy]]]",
    );
  });

  it("링크가 아닌 대괄호 텍스트의 escape 도 풀린다", () => {
    // 위키링크만 대상으로 삼으면 `\[대괄호\]` 는 백슬래시째 볼트에 눌러앉는다.
    expect(backToObsidian("본문 \\[대괄호\\] 텍스트.")).toBe("본문 [대괄호] 텍스트.");
  });

  it("각주 escape 도 함께 풀린다", () => {
    expect(backToObsidian("본문\\[^1\\]")).toBe("본문[^1]");
  });

  it("escape 된 백슬래시 뒤 대괄호는 escape 가 아니다", () => {
    // `\\[` 는 "리터럴 백슬래시 + 여는 대괄호" 다 — `[` 는 escape 된 적이 없다.
    // 구분하지 못하면 왕복마다 백슬래시를 한 겹씩 갉아먹어 파일이 영영 수렴하지 않는다
    // (정규식 패턴을 본문에 적어 둔 노트에서 발산 실측).
    const notion = "패턴 ((.\\*?)\\\\[\\\\s\\*\\\\](.\\*))";

    expect(backToObsidian(notion)).toBe(notion);
  });

  it("한 번 푼 결과를 다시 넣어도 더 줄지 않는다(멱등)", () => {
    const once = backToObsidian("본문 \\[대괄호\\] 와 \\\\[리터럴\\\\]");

    expect(backToObsidian(once)).toBe(once);
  });

  it("escape 된 링크 문법은 되살리지 않는다", () => {
    // 사용자가 "링크로 보이지 말라"고 escape 한 것이다 — 풀면 없던 링크가 생긴다.
    const notion = "\\[링크 아님\\](https://example.com)";

    expect(backToObsidian(notion)).toBe(notion);
  });

  it("코드블록 안 escape 는 건드리지 않는다", () => {
    const notion = "```js\nconst a = \\[1\\];\n```";

    expect(backToObsidian(notion)).toBe(notion);
  });

  it("복원이 확인되면 위키링크 보존 마커가 본문에 새지 않는다", () => {
    // 반쯤 풀린 `[[\[happy]]\]` 는 `[[happy]]` 리터럴이 아니라서 injector 가 "복원 실패"로
    // 판정하고 마커 줄을 본문에 그대로 흘렸다(실 Notion 왕복 실측).
    const markers: PreserveMarker[] = [
      { type: "wikilink", params: { text: "happy" }, startIndex: 0 },
    ];

    const out = backToObsidian("중첩 대괄호: \\[\\[\\[happy\\]\\]\\]", plain, markers);

    expect(out).toBe("중첩 대괄호: [[[happy]]]");
    expect(out).not.toContain("im-nobsidian:wikilink");
  });
});

describe("D-WIKIPAREN — 괄호가 든 제목이 깨지지 않는다", () => {
  // 볼트 558건 / 202파일. Notion 이 붙이는 `(1)` 중복 접미사가 주범이다.
  it("괄호 제목 위키링크가 왕복한다", () => {
    expect(roundtrip("[[T24 대상 (1)]]")).toBe("[[T24 대상 (1)]]");
  });

  it("괄호 제목 + 별칭이 왕복한다", () => {
    expect(roundtrip("[[T24 대상 (1)|보여줄 이름]]")).toBe("[[T24 대상 (1)|보여줄 이름]]");
  });

  it("괄호 제목 임베드가 왕복한다", () => {
    expect(roundtrip("![[AI Engineer (1).png]]")).toBe("![[AI Engineer (1).png]]");
  });

  it("push 산출물에 링크 문법이 깨진 흔적이 없다", () => {
    const notion = toNotion("[[T24 대상 (1)]]");

    // 예전 산출물: `[[T24 대상 (1|T24 대상 (1)]])` — 라벨과 URL 경계가 무너졌다.
    expect(notion).toBe("[[T24 대상 (1)]]");
  });

  // 이미 Notion 에 올라가 있는 구버전 마커(괄호 미인코딩)도 복원돼야 한다 —
  // 인코딩만 고치면 기존 페이지는 영영 깨진 채로 남는다.
  it("괄호를 인코딩하지 않은 구버전 마커도 복원한다", () => {
    const legacy = "[T24 대상 (1)](im-nobsidian://wikilink/T24%20대상%20(1))";

    expect(obsidianToNotionEnhanced(legacy)).toBe("[[T24 대상 (1)]]");
  });
});

describe("D-ALIAS-LOST — 해소된 링크의 별칭이 사라지지 않는다", () => {
  // mention 은 라벨을 못 가져 대상 페이지의 현재 제목만 렌더한다 — 별칭이 통째로 증발했다.
  it("해소된 위키링크의 별칭이 왕복한다", () => {
    expect(roundtrip("[[T2-target|다른 이름]]", linked)).toBe("[[T2-target|다른 이름]]");
  });

  it("별칭 있는 해소 링크는 라벨 달린 페이지 링크로 나간다", () => {
    expect(toNotion("[[T2-target|다른 이름]]", linked)).toBe(
      `[다른 이름](https://www.notion.so/${TARGET_ID_NOHYPH})`,
    );
  });

  it("별칭 없는 해소 링크는 여전히 page mention 이다", () => {
    expect(toNotion("[[T2-target]]", linked)).toBe(
      `<mention-page url="https://www.notion.so/${TARGET_ID_NOHYPH}"/>`,
    );
    expect(roundtrip("[[T2-target]]", linked)).toBe("[[T2-target]]");
  });

  it("미해소 위키링크의 별칭도 왕복한다", () => {
    expect(roundtrip("[[없는대상|다른 이름]]")).toBe("[[없는대상|다른 이름]]");
  });
});

describe("D-EMBEDALIAS — 별칭 붙은 임베드도 업로드 대상에 들어간다", () => {
  it("별칭 이미지가 images 에 실제 볼트 경로로 실린다", () => {
    const push = plain.convertToNotion("![[사진.png|300]]", { direction: "push", path: "t.md" });

    expect(push.images).toEqual([
      { url: "사진.png|300", localPath: "사진.png", isExternal: false },
    ]);
  });

  it("별칭 첨부(비이미지)가 왕복한다", () => {
    expect(roundtrip("![[보고서.pdf|첨부 설명]]")).toBe("![[보고서.pdf|첨부 설명]]");
  });
});
