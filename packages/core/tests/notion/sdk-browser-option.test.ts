/**
 * SDK 5.27 부터 `window.document` 가 있는 곳에서 토큰을 주면 `BrowserTokenNotAllowedError` 를 던진다. Obsidian
 * 플러그인은 렌더러(브라우저 환경)에서 돈다 — 잠금 파일이 SDK 를 올리는 날 플러그인이 시작하지 못한다. 토큰은
 * 사용자 기기의 볼트 설정에 있고 남이 여는 페이지가 아니므로 그 검사를 끈다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const seen: Array<Record<string, unknown>> = [];
vi.mock("@notionhq/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@notionhq/client")>();
  class Recording extends actual.Client {
    constructor(options?: ConstructorParameters<typeof actual.Client>[0]) {
      seen.push({ ...(options as Record<string, unknown>) });
      super(options);
    }
  }
  return { ...actual, Client: Recording };
});

const { NotionClient } = await import("../../src/notion/client.js");

describe("SDK 의 브라우저 토큰 검사", () => {
  afterEach(() => {
    seen.length = 0;
  });

  it("Obsidian(브라우저 환경)에서도 SDK 가 토큰을 받게 한다", () => {
    new NotionClient({ token: "offline-test" });
    expect(seen.at(-1)).toMatchObject({ auth: "offline-test", dangerouslyAllowBrowser: true });
  });
});
