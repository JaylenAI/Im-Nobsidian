/**
 * 단위 · 통합 시험은 실제 네트워크에 나가지 않는다(T-01).
 *
 * SDK 는 만들 때의 전역 fetch 를 쓴다. 목을 빠뜨린 호출은 가짜 토큰으로 api.notion.com 에 나가
 * 실패하는데, 시험은 그 오류를 삼켜 통과하니 빠뜨린 것이 보이지 않았다 — 느린 망에서는 재시도 ·
 * 시간 초과로 전량 실행을 가끔 깨뜨렸다. 여기서 fetch 를 막고, 부른 시험을 실패시킨다.
 *
 * 실제 Notion 이 필요한 시험은 불변식(`vitest.invariant.config.ts`)으로 돌린다 — 그 설정은 이 파일을
 * 싣지 않는다.
 */
import { afterEach, expect } from "vitest";

const attempted: string[] = [];

globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  attempted.push(url);
  throw new TypeError(`시험이 실제 네트워크를 부름 — 목을 쓰세요: ${url}`);
};

afterEach(() => {
  expect(attempted.splice(0), "시험이 실제 네트워크를 불렀다 — 목을 쓰세요").toEqual([]);
});
