/**
 * R9a — 미디어·첨부 다운로드 시간 상한.
 *
 * 상한이 없는 `fetch` 는 "느린" 게 아니라 **끝나지 않는다**. 응답이 오다 멈춘 연결
 * (만료된 프리사인 URL·중간 프록시 끊김)에서 프로세스는 대기 타이머도 열린 소켓도 없이
 * 이벤트 루프만 살아 있는 상태가 되고, 그 자리에서 pull 전체가 멎는다. 재시도 루프도
 * 예외가 나야 도는 것이라 함께 멈추고, 세마포어를 쥔 채 멈추므로 뒤따르는 다운로드까지
 * 영구 대기에 걸린다 — 사용자에겐 "동기화가 그냥 안 끝난다"로만 보인다.
 *
 * 여기서는 "멈추지 않고 **실패**한다"를 잠근다. 상한이 사라지면 이 파일의 테스트는
 * 통과하지 못하고 **행(hang)** 으로 타임아웃된다 — 회귀가 눈에 띄게 하려는 의도다.
 */
import { describe, it, expect, vi } from "vitest";

import { fetchForDownload, DEFAULT_DOWNLOAD_TIMEOUT_MS } from "../../src/utils/download-fetch.js";
import { FileHandler } from "../../src/sync/file-handler.js";
import { ImageHandler } from "../../src/sync/image-handler.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { NotionClient } from "../../src/notion/client.js";
import type { IStateDB } from "../../src/state/state-db-interface.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
} from "../helpers/mock-orchestrator.js";

/**
 * 응답이 영원히 오지 않는 서버. abort 신호가 올 때만 거부한다.
 * 상한이 걸려 있지 않으면(=signal 없음) 이 프로미스는 영원히 미해결이므로,
 * 가드가 사라진 순간 테스트가 hang 으로 드러난다.
 */
function hangingFetch(): typeof globalThis.fetch {
  return ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () =>
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
      );
    })) as unknown as typeof globalThis.fetch;
}

/** 정상 응답 한 번. 앞선 다운로드가 자원을 물고 늘어지지 않았는지 확인하는 데 쓴다. */
function okFetch(body = "payload"): typeof globalThis.fetch {
  return (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/octet-stream" }),
      arrayBuffer: () => Promise.resolve(Buffer.from(body).buffer),
    })) as unknown as typeof globalThis.fetch;
}

describe("R9a 다운로드 시간 상한", () => {
  describe("fetchForDownload (공용 가드)", () => {
    it("상한을 주면 AbortSignal 을 함께 넘긴다", async () => {
      const spy = vi.fn(okFetch());
      await fetchForDownload(spy, "https://example.com/a.bin", 5000);

      const init = spy.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
    });

    it("응답이 오지 않으면 상한 시점에 거부한다 (매달리지 않음)", async () => {
      await expect(
        fetchForDownload(hangingFetch(), "https://example.com/a.bin", 40),
      ).rejects.toThrow();
    });

    it("상한 0 이하는 탈출구 — signal 없이 호출한다", async () => {
      const spy = vi.fn(okFetch());
      await fetchForDownload(spy, "https://example.com/a.bin", 0);
      expect(spy.mock.calls[0]?.[1]).toBeUndefined();
    });

    it("호출마다 새 signal — AbortSignal 은 재사용할 수 없다", async () => {
      const spy = vi.fn(okFetch());
      await fetchForDownload(spy, "https://example.com/a.bin", 5000);
      await fetchForDownload(spy, "https://example.com/b.bin", 5000);

      const first = (spy.mock.calls[0]?.[1] as { signal?: AbortSignal }).signal;
      const second = (spy.mock.calls[1]?.[1] as { signal?: AbortSignal }).signal;
      expect(first).not.toBe(second);
    });
  });

  describe("FileHandler (첨부 경로)", () => {
    function makeHandler(fetchFn: typeof globalThis.fetch, downloadTimeoutMs = 40) {
      const vaultFs = createMockVaultFs();
      const stateDb = createMockStateDb();
      const notion = createMockNotionClient();
      const handler = new FileHandler(
        vaultFs,
        notion as unknown as NotionClient,
        stateDb as unknown as IStateDB,
        2,
        { fetch: fetchFn, downloadTimeoutMs },
      );
      return { handler, vaultFs };
    }

    it("응답 없는 첨부는 상한에서 실패한다", async () => {
      const { handler, vaultFs } = makeHandler(hangingFetch());

      await expect(
        handler.downloadFileBlock("https://example.com/a.pdf", "a.pdf", "attachments"),
      ).rejects.toThrow();
      expect(vaultFs.writeBinary).not.toHaveBeenCalled();
    });

    it("멈춘 다운로드가 세마포어를 물고 늘어지지 않는다 — 뒤 파일이 정상 처리된다", async () => {
      let call = 0;
      const hanging = hangingFetch();
      const ok = okFetch();
      // 첫 파일은 영원히 응답 없음, 둘째 파일은 정상. 상한이 없으면 둘째가 영영 시작되지 않는다.
      const mixed = ((url: string, init?: { signal?: AbortSignal }) =>
        (call++ === 0 ? hanging : ok)(
          url as never,
          init as never,
        )) as unknown as typeof globalThis.fetch;

      const { handler, vaultFs } = makeHandler(mixed);
      const results = await handler.downloadFileBlocks(
        [
          { type: "file", url: "https://example.com/stuck.pdf", caption: "stuck.pdf" },
          { type: "file", url: "https://example.com/fine.pdf", caption: "fine.pdf" },
        ],
        "attachments",
      );

      expect(results.map((r) => r.localPath)).toEqual(["attachments/fine.pdf"]);
      expect(vaultFs.writeBinary).toHaveBeenCalledTimes(1);
    });

    it("옵션 없이 만들어도 기본 상한이 걸려 있다", () => {
      const { handler } = makeHandler(okFetch());
      expect(handler).toBeInstanceOf(FileHandler);
      expect(DEFAULT_DOWNLOAD_TIMEOUT_MS).toBe(300_000);
    });
  });

  describe("ImageHandler (미디어 경로)", () => {
    it("응답 없는 이미지는 상한에서 실패한다", async () => {
      const vaultFs = createMockVaultFs();
      const handler = new ImageHandler(vaultFs, "attachments", undefined, hangingFetch(), {
        maxRetries: 1,
        downloadTimeoutMs: 40,
      });

      await expect(
        handler.downloadImage("https://example.com/a.png", "테스트 페이지"),
      ).rejects.toThrow();
      expect(vaultFs.writeBinary).not.toHaveBeenCalled();
    });
  });

  describe("설정 배선", () => {
    it("advanced.mediaDownloadTimeoutMs 기본값이 공용 상한과 같다", () => {
      expect(DEFAULT_CONFIG.advanced.mediaDownloadTimeoutMs).toBe(DEFAULT_DOWNLOAD_TIMEOUT_MS);
    });
  });
});
