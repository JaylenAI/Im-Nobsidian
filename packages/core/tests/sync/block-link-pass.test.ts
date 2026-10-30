/**
 * pull 끝의 링크 패스 — 변환 때 아직 받지 않은 페이지로 가는 블록 링크를 그 블록을 읽어 `[[노트#제목]]` 으로 (P6).
 */
import { describe, it, expect, vi } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const TARGET = "26d279f5d6728014b877dffb738dc221";
const OUTSIDE = "37e279f5d6728014b877dffb738dc221";
const HEADING = "a".repeat(32);
const SOURCE = { id: 1, obsidianPath: "source.md", notionPageId: "b".repeat(32) };
const TARGET_RECORD = { id: 2, obsidianPath: "폴더/새 노트.md", notionPageId: TARGET };

async function postPass(original: string) {
  let written: string | null = null;
  const vaultFs = createMockVaultFs();
  (vaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(original);
  (vaultFs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
    async (_p: string, content: string) => {
      written = content;
    },
  );
  const stateDb = createMockStateDb();
  stateDb.getAll.mockReturnValue([SOURCE, TARGET_RECORD]);
  stateDb.getByPath.mockReturnValue(SOURCE);
  const notion = createMockNotionClient();
  const getBlock = vi.fn(async (id: string) => {
    if (id !== HEADING) throw new Error("Could not find block");
    return { id, type: "heading_2", heading_2: { rich_text: [{ plain_text: "새 제목" }] } };
  });
  (notion as unknown as { getBlock: typeof getBlock }).getBlock = getBlock;
  const orchestrator = new SyncOrchestrator(
    createConfig(),
    stateDb as never,
    notion as never,
    vaultFs,
  );
  await (
    orchestrator as unknown as { resolveNotionLinks(paths: string[]): Promise<number> }
  ).resolveNotionLinks(["source.md"]);
  return { written: written as string | null, getBlock };
}

describe("pull 끝의 링크 패스 — 블록 링크", () => {
  it("나중에 받은 노트의 제목으로 가는 링크를 풀고, 같은 블록은 한 번만 읽는다", async () => {
    const link = `https://app.notion.com/p/${TARGET}#${HEADING}`;
    const { written, getBlock } = await postPass(
      `[새 노트 \\> 새 제목](${link}) · [여기](${link})`,
    );

    expect(written).toBe("[[새 노트#새 제목]] · [[새 노트#새 제목|여기]]");
    expect(getBlock).toHaveBeenCalledTimes(1);
  });

  it("볼트 밖 페이지로 가는 블록 링크는 읽지 않고 그대로", async () => {
    const { written, getBlock } = await postPass(
      `[밖](https://app.notion.com/p/${OUTSIDE}#${HEADING})`,
    );

    expect(written).toBeNull();
    expect(getBlock).not.toHaveBeenCalled();
  });

  it("읽지 못한 블록은 Notion 링크로 남긴다", async () => {
    const md = `[가](https://app.notion.com/p/${TARGET}#${"c".repeat(32)})`;
    const { written } = await postPass(md);

    expect(written).toBeNull();
  });
});
