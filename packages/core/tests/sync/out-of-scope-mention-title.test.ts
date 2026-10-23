/**
 * 볼트 밖 페이지 멘션의 이름 — Notion 은 멘션을 `<mention-page url="…"/>` 로, 제목 없이 준다. 볼트에서 찾지
 * 못하면 `[<id>](https://www.notion.so/<id>)` 로 남아 사람이 읽을 수 없었다(2026-10-22 실데이터 E2E — 범위
 * 밖을 가리키는 8 노트). 남기기 전에 그 페이지의 제목을 한 번 읽어 링크 글자로 쓴다.
 */
import { describe, it, expect, vi } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const OUTSIDE = "26d279f5d6728014b877dffb738dc221";
const GONE = "37e279f5d6728014b877dffb738dc221";
const SOURCE = { id: 1, obsidianPath: "source.md", notionPageId: "b".repeat(32) };

async function postPass(original: string, titles: Record<string, string>) {
  let written: string | null = null;
  const vaultFs = createMockVaultFs();
  (vaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(original);
  (vaultFs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
    async (_p: string, content: string) => {
      written = content;
    },
  );
  const stateDb = createMockStateDb();
  stateDb.getAll.mockReturnValue([SOURCE]);
  stateDb.getByPath.mockReturnValue(SOURCE);
  const notion = createMockNotionClient();
  notion.getPage.mockImplementation(async (id: string) => {
    const title = titles[id.replace(/-/g, "")];
    if (title === undefined) throw new Error("Could not find page");
    return { id, title } as never;
  });
  notion.extractTitle = vi.fn((page: { title: string }) => page.title) as never;
  const orchestrator = new SyncOrchestrator(
    createConfig(),
    stateDb as never,
    notion as never,
    vaultFs,
  );
  await (
    orchestrator as unknown as { resolveNotionLinks(paths: string[]): Promise<number> }
  ).resolveNotionLinks(["source.md"]);
  return { written: written as string | null, getPage: notion.getPage };
}

describe("볼트 밖 페이지 멘션 — 제목을 링크 글자로", () => {
  it("제목을 읽어 링크 글자로 쓴다 — 같은 페이지는 한 번만 읽는다", async () => {
    const { written, getPage } = await postPass(
      `앞 [[notion:${OUTSIDE}]] 와 [[notion:${OUTSIDE}]] 뒤`,
      { [OUTSIDE]: "회의 [초안]" },
    );

    expect(written).toBe(
      `앞 [회의 (초안)](https://www.notion.so/${OUTSIDE}) 와 [회의 (초안)](https://www.notion.so/${OUTSIDE}) 뒤`,
    );
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it("제목의 강조 기호는 글자로 — 다시 받아도 같은 링크", async () => {
    const { written } = await postPass(`[[notion:${OUTSIDE}]]`, {
      [OUTSIDE]: "__초안__ *메모* $5",
    });

    expect(written).toBe(`[\\_\\_초안\\_\\_ \\*메모\\* $5](https://www.notion.so/${OUTSIDE})`);
    const again = await postPass(notionEnhancedToObsidian(written!), {});
    expect(again.written).toBe(written);
  });

  it("읽지 못한 페이지는 예전처럼 id", async () => {
    const { written } = await postPass(`앞 [[notion:${GONE}]] 뒤`, {});

    expect(written).toBe(`앞 [${GONE}](https://www.notion.so/${GONE}) 뒤`);
  });

  it("별칭이 있으면 별칭 — 읽지 않는다", async () => {
    const { written, getPage } = await postPass(`[[notion:${OUTSIDE}|별칭]]`, {
      [OUTSIDE]: "제목",
    });

    expect(written).toBe(`[별칭](https://www.notion.so/${OUTSIDE})`);
    expect(getPage).not.toHaveBeenCalled();
  });
});
