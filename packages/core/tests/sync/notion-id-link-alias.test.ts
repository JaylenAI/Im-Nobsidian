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
import { resolveNotionIdWikilinks } from "../../src/converter/notion-id-links.js";
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

  it("미추적 id 는 별칭째 원형 보존하고 파일을 건드리지 않는다", async () => {
    const original = `[[notion:${UNTRACKED}|License]] 와 [[notion:${UNTRACKED}]].\n`;
    const { written, count } = await runPostPass(original);

    // id 를 버리면 다음 pull 에서도 복구할 수 없다. 변경이 없으니 write 도 없어야
    // 한다 — 아니면 churn 0 이 깨진다.
    expect(count).toBe(0);
    expect(written).toBeNull();
  });
});

describe("R10 — 변환 패스와 후처리 패스가 같은 입력에 같은 출력을 낸다", () => {
  // 결함군 자체를 잠근다: 한쪽 경로에만 규칙이 추가되는 순간 이 테스트가 깨진다.
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
    it(`대칭: ${input}`, async () => {
      const { written } = await runPostPass(`${input}\n`);
      const post = written ?? `${input}\n`;

      expect(post).toBe(`${runConversionPass(input)}\n`);
    });
  }
});
