import { describe, it, expect, vi, afterEach } from "vitest";
import { extractRetryAfter } from "../../src/notion/client.js";

/**
 * R4 D-RETRYAFTER-UNBOUNDED 회귀 잠금.
 *
 * 재시도 대기는 틀려도 로그에 아무 흔적이 남지 않는다 — 그저 너무 빨리(429 재발) 또는
 * 너무 오래(프로세스 정지) 기다릴 뿐이다. 그래서 세 가지를 단언으로 못 박는다:
 *   1. RFC 9110 이 허용하는 HTTP-date 형식을 해석한다(예전 `Number(raw)*1000` 은 NaN →
 *      `setTimeout(_, NaN)` 이 **즉시** 깨어나 429 직후 무대기 재시도가 됐다).
 *   2. 해석 불가/과거 시각은 null 로 떨궈 지수 백오프에 맡긴다.
 *   3. 서버가 한 시간을 부르더라도 60초에서 자른다.
 */
describe("extractRetryAfter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("초 단위 숫자를 밀리초로 환산", () => {
    expect(extractRetryAfter({ headers: { "retry-after": "3" } })).toBe(3000);
    expect(extractRetryAfter({ headers: { "retry-after": "0.5" } })).toBe(500);
  });

  it("HTTP-date 형식을 남은 시간으로 환산 (NaN 즉시재시도 금지)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const result = extractRetryAfter({
      headers: { "retry-after": "Thu, 01 Jan 2026 00:00:10 GMT" },
    });
    expect(result).toBe(10_000);
  });

  it("이미 지난 HTTP-date 는 null — 0 이하 대기는 백오프에 맡긴다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
    expect(
      extractRetryAfter({ headers: { "retry-after": "Thu, 01 Jan 2026 00:00:10 GMT" } }),
    ).toBeNull();
  });

  it("해석할 수 없는 값은 null", () => {
    expect(extractRetryAfter({ headers: { "retry-after": "soon" } })).toBeNull();
    expect(extractRetryAfter({ headers: { "retry-after": "" } })).toBeNull();
    expect(extractRetryAfter({ headers: {} })).toBeNull();
  });

  it("0 이하 초는 null", () => {
    expect(extractRetryAfter({ headers: { "retry-after": "0" } })).toBeNull();
    expect(extractRetryAfter({ headers: { "retry-after": "-5" } })).toBeNull();
  });

  it("과도한 대기는 60초로 자른다 — 한 시간 정지 금지", () => {
    expect(extractRetryAfter({ headers: { "retry-after": "3600" } })).toBe(60_000);
    expect(extractRetryAfter({ headers: { "retry-after": "60" } })).toBe(60_000);
    expect(extractRetryAfter({ headers: { "retry-after": "59" } })).toBe(59_000);
  });

  it("헤더가 없는 오류 형태는 null", () => {
    expect(extractRetryAfter(null)).toBeNull();
    expect(extractRetryAfter(undefined)).toBeNull();
    expect(extractRetryAfter("rate limited")).toBeNull();
    expect(extractRetryAfter(new Error("boom"))).toBeNull();
  });
});

/**
 * R9d D-RETRYAFTER-HEADERS 회귀 잠금.
 *
 * 위 테스트들이 전부 통과하는데도 **프로덕션에서는 `Retry-After` 가 한 번도 반영되지
 * 않았다.** 테스트가 평범한 객체(`{ "retry-after": "3" }`)를 넘긴 반면, 실제
 * `@notionhq/client` 는 fetch 응답의 `Headers` 인스턴스를 그대로 실어 오기 때문이다
 * (`errors.js` → `headers: response.headers`, 타입은 `unknown`). `Headers` 는 인덱스
 * 접근에 항상 undefined 를 주므로 예전 구현은 조용히 null 로 떨어졌고, 429 폭풍에서
 * 서버가 지정한 대기 대신 지수 백오프로만 물러났다.
 *
 * 그래서 **실제 `Headers` 객체**로 잠근다 — 목이 아니라 런타임이 주는 그 타입으로.
 */
describe("extractRetryAfter — SDK 가 주는 헤더 모양", () => {
  it("fetch Headers 인스턴스에서 읽는다 (인덱스 접근 불가 타입)", () => {
    const headers = new Headers({ "Retry-After": "3" });
    // 이 단언이 이 테스트의 존재 이유다 — 인덱스로는 값이 안 나온다.
    expect((headers as unknown as Record<string, string>)["retry-after"]).toBeUndefined();
    expect(extractRetryAfter({ headers })).toBe(3000);
  });

  it("Headers 에 Retry-After 가 없으면 null", () => {
    expect(
      extractRetryAfter({ headers: new Headers({ "content-type": "application/json" }) }),
    ).toBeNull();
  });

  it("Map 형태 헤더도 읽는다 (커스텀 fetch 주입 대비)", () => {
    expect(extractRetryAfter({ headers: new Map([["retry-after", "2"]]) })).toBe(2000);
  });

  it("평범한 객체는 대소문자를 가리지 않는다", () => {
    expect(extractRetryAfter({ headers: { "Retry-After": "4" } })).toBe(4000);
    expect(extractRetryAfter({ headers: { "RETRY-AFTER": "5" } })).toBe(5000);
  });

  it("문자열이 아닌 헤더 값은 null — 숫자 강제변환 금지", () => {
    expect(extractRetryAfter({ headers: { "retry-after": 3 } })).toBeNull();
    expect(extractRetryAfter({ headers: null })).toBeNull();
    expect(extractRetryAfter({ headers: "retry-after: 3" })).toBeNull();
  });
});
