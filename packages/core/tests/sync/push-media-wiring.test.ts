/**
 * R1 배선 잠금 — 오케스트레이터가 임베드 미디어를 **한 번만** 올리는지 확인한다.
 *
 * R1 이전에는 임베드 하나가 Notion 에서 두 조각으로 갈라졌다: 본문 자리에는 자리표시자
 * quote(마커 리터럴), 페이지 맨 끝에는 실제 이미지 블록. 제자리 교체를 도입한 뒤에도
 * 꼬리 append 를 그대로 두면 같은 이미지를 두 번 올려 중복이 남는다. 반대로 폴백을
 * 없애면 본문 push 가 스킵된 페이지(자리표시자 없음)에서 이미지가 통째로 사라진다.
 * 두 방향 모두를 여기서 고정한다.
 */
import { describe, it, expect, vi } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const MARKER_TEXT = "📎 a.png %% im-nobsidian:local-image:a.png %%";

/** 자리표시자 quote 를 `children` 으로 돌려주는 페이지를 만들어 push 를 1회 실행한다. */
async function pushNoteWithEmbed(children: unknown[]) {
  const mockVaultFs = createMockVaultFs();
  const mockStateDb = createMockStateDb();
  const mockNotionClient = createMockNotionClient();
  const orchestrator = new SyncOrchestrator(
    createConfig(),
    mockStateDb as never,
    mockNotionClient as never,
    mockVaultFs,
  );

  const markdown = "# 노트\n\n![[a.png]]\n";
  (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
    { path: "note.md", mtime: "2026-05-30T00:00:00.000Z", size: markdown.length },
  ]);
  (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(markdown);
  (mockNotionClient.fetchAllChildren as ReturnType<typeof vi.fn>).mockResolvedValue(children);

  const result = await orchestrator.push();
  expect(result.created).toBe(1);
  return mockNotionClient;
}

describe("SyncOrchestrator — 임베드 미디어 push 배선(R1)", () => {
  it("자리표시자가 있으면 제자리 교체만 하고 꼬리에 또 붙이지 않는다", async () => {
    const client = await pushNoteWithEmbed([
      {
        id: "blk-ph",
        type: "quote",
        has_children: false,
        quote: { rich_text: [{ plain_text: MARKER_TEXT }] },
      },
    ]);

    // 업로드 1회 = 중복 없음. R1 이전이라면 제자리 + 꼬리로 2회가 된다.
    expect(client.uploadFile).toHaveBeenCalledTimes(1);

    const mediaAppends = (client.appendChildren as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1][0] as { type?: string })?.type === "image",
    );
    expect(mediaAppends).toHaveLength(1);
    // 제자리 삽입이므로 반드시 after 옵션이 붙는다(= 본문 흐름 유지).
    expect(mediaAppends[0]![2]).toEqual({ after: "blk-ph" });
    expect(client.deleteBlock).toHaveBeenCalledWith("blk-ph");
  });

  it("자리표시자가 없으면(본문 push 스킵 등) 꼬리 append 폴백으로 이미지를 살린다", async () => {
    const client = await pushNoteWithEmbed([]);

    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    const mediaAppends = (client.appendChildren as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1][0] as { type?: string })?.type === "image",
    );
    expect(mediaAppends).toHaveLength(1);
    // 폴백은 페이지 끝에 붙이므로 위치 옵션이 없다.
    expect(mediaAppends[0]![2]).toBeUndefined();
  });
});
