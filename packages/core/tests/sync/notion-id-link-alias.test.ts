/**
 * R10 — `[[notion:<id>]]` 해소의 두 경로 대칭.
 *
 * pull 은 같은 계약을 **두 지점**에서 이행한다.
 *   1. 변환 시점: 페이지 하나를 마크다운으로 만들 때(resolveNotionIdWikilinks)
 *   2. pull 마감: 이번 pull 이 기록한 파일 전부를 훑는 후처리(resolveNotionLinks)
 *
 * 2번이 필요한 이유는 정방향 참조다 — A 가 B 를 가리키는데 B 가 같은 pull 의 **나중**에
 * 만들어지면, A 를 변환하던 1번 시점엔 B 가 상태 DB 에 없어 해소가 실패한다. 2번이
 * 뒤늦게 메워 준다.
 *
 * 그런데 2번은 자체 정규식(`/\[\[notion:([a-f0-9-]+)\]\]/`)을 들고 있어 **별칭 달린
 * 형태를 아예 매치하지 못했다**. 결과: 대상이 볼트에 실재하는데도 영영 끊긴 위키링크로
 * 남는다. 지정 볼트 실측에서 별칭 없는 형태는 13건 전부 해소됐고, 별칭 형태는 대상이
 * 볼트에 있는 2건이 미해소로 남아 이 비대칭을 그대로 드러냈다.
 *
 * R9a(image/file 핸들러)·R9e(페이지/DB 행)·R9f(업로드 루프 2곳)와 같은 결함군이라,
 * 개별 사례가 아니라 **두 경로가 같은 입력에 같은 출력을 낸다**는 성질 자체를 잠근다.
 */
import { describe, it, expect, vi } from "vitest";

import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import {
  resolveNotionIdWikilinks,
  degradeUnresolvedNotionIdWikilinks,
  resolveNotionRelativePageLinks,
  degradeUnresolvedNotionRelativePageLinks,
} from "../../src/converter/notion-id-links.js";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const TARGET_HYPH = "3aa13b18-d382-8184-9a76-f495d0a9a613";
const TARGET = TARGET_HYPH.replace(/-/g, "");
const UNTRACKED = "26d279f5d6728014b877dffb738dc221";

const SOURCE = { id: 1, obsidianPath: "source.md", notionPageId: "b".repeat(32) };
const TARGET_REC = { id: 2, obsidianPath: "노트/T24 대상 (1).md", notionPageId: TARGET };

/** 후처리 패스(resolveNotionLinks)를 실제 오케스트레이터로 돌리고 디스크 결과를 돌려준다. */
async function runPostPass(original: string): Promise<{ written: string | null; count: number }> {
  let written: string | null = null;
  const vaultFs = createMockVaultFs();
  (vaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(original);
  (vaultFs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
    async (_path: string, content: string) => {
      written = content;
    },
  );

  const stateDb = createMockStateDb();
  stateDb.getAll.mockReturnValue([SOURCE, TARGET_REC]);
  stateDb.getByPath.mockImplementation((p: string) => (p === "source.md" ? SOURCE : null));

  const orchestrator = new SyncOrchestrator(
    createConfig(),
    stateDb as never,
    createMockNotionClient() as never,
    vaultFs,
  );

  const count = await (
    orchestrator as unknown as { resolveNotionLinks(paths: string[]): Promise<number> }
  ).resolveNotionLinks(["source.md"]);

  return { written, count };
}

/** 변환 시점 패스 — 후처리와 같은 역조회 규칙을 쓴다. */
function runConversionPass(original: string): string {
  return resolveNotionIdWikilinks(original, (id) =>
    id.replace(/-/g, "") === TARGET ? TARGET_REC.obsidianPath : null,
  ).markdown;
}

describe("R10 — 후처리 패스가 별칭 달린 notion id 링크를 해소한다", () => {
  it("`[[notion:<id>|별칭]]` 이 `[[대상|별칭]]` 으로 해소된다", async () => {
    const { written, count } = await runPostPass(`본문 [[notion:${TARGET}|보여줄 이름]] 참조.\n`);

    // 결함 재현 시: 정규식이 별칭 형태를 못 잡아 count 0, written null 로 남는다.
    expect(count).toBe(1);
    expect(written).toBe("본문 [[T24 대상 (1)|보여줄 이름]] 참조.\n");
  });

  it("별칭 없는 형태는 종전대로 해소된다(회귀 방지)", async () => {
    const { written, count } = await runPostPass(`본문 [[notion:${TARGET}]] 참조.\n`);

    expect(count).toBe(1);
    expect(written).toBe("본문 [[T24 대상 (1)]] 참조.\n");
  });

  it("하이픈 붙은 id 표기도 해소된다", async () => {
    const { written, count } = await runPostPass(`본문 [[notion:${TARGET_HYPH}|별칭]] 참조.\n`);

    expect(count).toBe(1);
    expect(written).toBe("본문 [[T24 대상 (1)|별칭]] 참조.\n");
  });

  it("별칭이 대상 제목과 같으면 버린다 — `[[X|X]]` 를 만들지 않는다", async () => {
    // breadcrumb 처럼 라벨이 곧 대상 제목인 링크. `[[X|X]]` 를 남기면 push 가 별칭
    // 있는 링크로 오인해, mention 이어야 할 것을 평범한 URL 링크로 내보낸다.
    const { written } = await runPostPass(`본문 [[notion:${TARGET}|T24 대상 (1)]] 참조.\n`);

    expect(written).toBe("본문 [[T24 대상 (1)]] 참조.\n");
  });

  it("미추적 id 는 해소 건수로 세지 않는다", async () => {
    const { count } = await runPostPass(`[[notion:${UNTRACKED}|License]].\n`);

    expect(count).toBe(0);
  });
});

describe("R10 — 볼트 밖 페이지 링크는 죽은 위키링크가 아니라 동작하는 URL 로 남는다", () => {
  // 같은 breadcrumb 한 줄에서 url 링크는 동작하고 mention 만 끊긴 링크로 남던 비대칭.
  // 끊긴 `[[notion:26d2…]]` 는 클릭하면 그 이름의 빈 노트를 만들자고 해 볼트를 오염시킨다.
  it("별칭 있는 미추적 링크가 라벨을 살린 URL 링크가 된다", async () => {
    const { written } = await runPostPass(`앞 [[notion:${UNTRACKED}|License]] 뒤\n`);

    expect(written).toBe(`앞 [License](https://www.notion.so/${UNTRACKED}) 뒤\n`);
  });

  it("라벨 없는 미추적 링크는 id 를 라벨로 쓴다 — 그래도 클릭은 된다", async () => {
    const { written } = await runPostPass(`[[notion:${UNTRACKED}]]\n`);

    expect(written).toBe(`[${UNTRACKED}](https://www.notion.so/${UNTRACKED})\n`);
  });

  it("격하는 해소 **뒤**에만 일어난다 — 볼트에 있는 대상은 위키링크로 남는다", async () => {
    // 순서가 뒤집히면 볼트에 실재하는 대상까지 외부 링크로 굳어 그래프뷰에서 끊긴다.
    const { written } = await runPostPass(
      `[[notion:${TARGET}|별칭]] 과 [[notion:${UNTRACKED}|License]]\n`,
    );

    expect(written).toBe(
      `[[T24 대상 (1)|별칭]] 과 [License](https://www.notion.so/${UNTRACKED})\n`,
    );
  });

  it("격하형은 다시 pull 해도 id 를 잃지 않는다(왕복 폐쇄)", () => {
    // Notion 저장본이 격하형이 되어 돌아와도 1차 변환이 id 형태로 환원해야,
    // 그 페이지가 나중에 볼트에 들어왔을 때 정식 위키링크로 해소된다.
    const degraded = `[License](https://www.notion.so/${UNTRACKED})`;

    expect(notionEnhancedToObsidian(degraded)).toBe(`[[notion:${UNTRACKED}|License]]`);
  });

  it("라벨이 id 인 격하형이 돌아와도 별칭으로 굳지 않는다", () => {
    // `[[대상|26d2…]]` 로 굳으면 사람이 읽을 수 없는 링크가 된다.
    const back = notionEnhancedToObsidian(`[${TARGET}](https://www.notion.so/${TARGET})`);

    expect(runConversionPass(back)).toBe("[[T24 대상 (1)]]");
  });

  it("한 번 격하한 결과가 왕복 후에도 같은 바이트로 수렴한다(멱등)", async () => {
    // pull → push → pull 을 거쳐도 바이트가 같아야 매 sync 의 churn 이 0 으로 남는다.
    const first = (await runPostPass(`[[notion:${UNTRACKED}|License]]\n`)).written!;
    const second = await runPostPass(notionEnhancedToObsidian(first));

    expect(second.written).toBe(first);
  });
});

describe("R10-C — url 형 페이지 링크도 자기별칭을 접는다", () => {
  // pull 후처리는 **두 표기**를 해소한다. `[[notion:<id>]]`(1차 변환이 만드는 중간형)과
  // `[라벨](/p/<id>)`(Notion 이 내려주는 상대 링크)이다. 뒤쪽은 접기 규칙을 빠뜨려
  // 라벨이 곧 대상 제목인 링크를 `[[X|X]]` 로 굳혔다 — 실볼트 45건/12파일, 전부
  // breadcrumb 콜아웃. `[[X|X]]` 는 push 의 분기(별칭 유무로 mention/URL 링크를
  // 가른다)를 헛돌게 해 mention 이어야 할 링크를 평범한 URL 링크로 내보낸다.
  it("라벨이 대상 제목과 같으면 접힌다 — `[[X|X]]` 를 만들지 않는다", async () => {
    const { written } = await runPostPass(`> [!info] [T24 대상 (1)](/p/${TARGET})\n`);

    expect(written).toBe("> [!info] [[T24 대상 (1)]]\n");
  });

  it("라벨이 다르면 별칭으로 살린다(회귀 방지)", async () => {
    const { written } = await runPostPass(`[Home](/p/${TARGET})\n`);

    expect(written).toBe("[[T24 대상 (1)|Home]]\n");
  });

  it("`p/` 없는 구형 표기 + 쿼리스트링도 같은 규칙을 탄다", async () => {
    const { written } = await runPostPass(`[T24 대상 (1)](/${TARGET}?pvs=4)\n`);

    expect(written).toBe("[[T24 대상 (1)]]\n");
  });

  it("미추적 id 는 해소되지 않는다 — 위키링크로 만들지 않는다", async () => {
    const { count } = await runPostPass(`[License](/p/${UNTRACKED})\n`);

    // 해소 0건. 그 뒤 격하가 URL 링크로 바꾸는 건 R10-D 의 몫이다.
    expect(count).toBe(0);
  });

  it("핵심 불변식: 두 표기가 같은 대상·같은 라벨이면 **같은 바이트**를 낸다", async () => {
    // 결함군("같은 계약이 여러 경로에 있는데 한 경로만 안 지킨다") 자체를 잠근다.
    for (const label of ["T24 대상 (1)", "Home", "다른 이름"]) {
      const viaUrl = await runPostPass(`[${label}](/p/${TARGET})\n`);
      const viaId = await runPostPass(`[[notion:${TARGET}|${label}]]\n`);

      expect(viaUrl.written).toBe(viaId.written);
    }
  });

  it("접힌 결과에 다시 후처리를 돌려도 바뀌지 않는다(멱등)", async () => {
    const first = (await runPostPass(`[T24 대상 (1)](/p/${TARGET})\n`)).written!;
    const second = await runPostPass(first);

    // 이미 위키링크라 바꿀 게 없다 → 쓰기 자체가 일어나지 않는다.
    expect(second.written).toBe(null);
    expect(first).toBe("[[T24 대상 (1)]]\n");
  });
});

describe("R10-D — 볼트 밖 상대 페이지 링크도 동작하는 URL 로 격하한다", () => {
  // R10-B 는 `[[notion:<id>]]` 표기만 격하해, 같은 상황의 상대 url 표기가 그대로 남았다.
  // `/p/<id>` 는 Notion 앱 안에서만 뜻이 있어 옵시디언은 없는 파일을 가리키는 끊긴
  // 링크로 그린다 — 실볼트 89건/10파일, 대상 11개가 상태 DB 대조상 전부 볼트 밖.
  const NOTION_URL = `https://www.notion.so/${UNTRACKED}`;
  const ANCHOR = "190c32470be280b0875df96436067bc8";

  it("미추적 대상은 절대 URL 이 된다 — 상대 경로로 남기지 않는다", async () => {
    const { written } = await runPostPass(`[License](/p/${UNTRACKED}?pvs=25)\n`);

    expect(written).toBe(`[License](${NOTION_URL})\n`);
  });

  it("앵커는 살린다 — 각주 89건 중 80건이 앵커로 블록을 가리킨다", async () => {
    const { written } = await runPostPass(`[¹](/${UNTRACKED}?pvs=25#${ANCHOR})\n`);

    expect(written).toBe(`[¹](${NOTION_URL}#${ANCHOR})\n`);
  });

  it("볼트에 있는 대상은 격하되지 않는다 — 해소가 먼저다(순서 잠금)", async () => {
    // 격하를 해소 앞으로 옮기면 이 케이스가 외부 링크로 굳으면서 깨진다.
    const { written } = await runPostPass(`[Home](/p/${TARGET}?pvs=25)\n`);

    expect(written).toBe("[[T24 대상 (1)|Home]]\n");
  });

  it("핵심 불변식: 볼트 밖 링크는 두 표기가 **같은 목적지**를 낸다", async () => {
    const viaUrl = await runPostPass(`[License](/p/${UNTRACKED})\n`);
    const viaId = await runPostPass(`[[notion:${UNTRACKED}|License]]\n`);

    expect(viaUrl.written).toBe(viaId.written);
    expect(viaUrl.written).toBe(`[License](${NOTION_URL})\n`);
  });

  it("멱등: 격하 결과에 다시 후처리를 돌려도 바뀌지 않는다", async () => {
    for (const degraded of [`[License](${NOTION_URL})\n`, `[¹](${NOTION_URL}#${ANCHOR})\n`]) {
      const again = await runPostPass(degraded);

      expect(again.written).toBe(null);
    }
  });

  it("Notion id 가 아닌 상대 링크는 건드리지 않는다", async () => {
    const { written } = await runPostPass("[문서](/docs/guide.md)\n![](/assets/a.png)\n");

    expect(written).toBe(null);
  });
});

describe("R10 — 후처리는 공유 해소 + 공유 격하의 합성일 뿐이다", () => {
  // 결함군 자체를 잠근다: 후처리가 자기만의 규칙을 하나라도 갖는 순간 깨진다.
  //
  // 격하는 변환 시점이 아니라 pull 마감에만 일어난다 — 변환 시점엔 대상이 아직
  // 안 만들어졌을 수 있어(정방향 참조) 그때 격하하면 볼트에 실재할 대상까지
  // 외부 링크로 굳는다. 그래서 기대값도 `격하(해소(x))` 합성으로 쓴다.
  const CASES = [
    `[[notion:${TARGET}]]`,
    `[[notion:${TARGET}|별칭]]`,
    `[[notion:${TARGET_HYPH}]]`,
    `[[notion:${TARGET_HYPH}|별칭]]`,
    `[[notion:${TARGET}|T24 대상 (1)]]`,
    `[[notion:${UNTRACKED}]]`,
    `[[notion:${UNTRACKED}|License]]`,
    `앞 [[notion:${TARGET}|A]] 사이 [[notion:${UNTRACKED}|B]] 뒤`,
  ];

  for (const input of CASES) {
    it(`합성 일치: ${input}`, async () => {
      const { written } = await runPostPass(`${input}\n`);
      const post = written ?? `${input}\n`;
      const composed = degradeUnresolvedNotionIdWikilinks(runConversionPass(input)).markdown;

      expect(post).toBe(`${composed}\n`);
    });
  }

  // url 표기도 **같은 성질**을 갖는다 — 후처리가 이 갈래에만 자기 규칙을 두는 순간
  // 깨진다. R10-C(접기 누락)와 R10-D(격하 누락)가 정확히 그렇게 새어 나왔다.
  const URL_CASES = [
    `[T24 대상 (1)](/p/${TARGET})`,
    `[Home](/p/${TARGET}?pvs=25)`,
    `[T24 대상 (1)](/${TARGET})`,
    `[License](/p/${UNTRACKED})`,
    `[¹](/${UNTRACKED}?pvs=25#${"a".repeat(32)})`,
    `앞 [A](/p/${TARGET}) 사이 [B](/p/${UNTRACKED}) 뒤`,
  ];

  for (const input of URL_CASES) {
    it(`합성 일치(url 표기): ${input}`, async () => {
      const { written } = await runPostPass(`${input}\n`);
      const post = written ?? `${input}\n`;
      const resolved = resolveNotionRelativePageLinks(input, (id) =>
        id.replace(/-/g, "") === TARGET ? TARGET_REC.obsidianPath : null,
      ).markdown;
      const composed = degradeUnresolvedNotionRelativePageLinks(resolved).markdown;

      expect(post).toBe(`${composed}\n`);
    });
  }
});
