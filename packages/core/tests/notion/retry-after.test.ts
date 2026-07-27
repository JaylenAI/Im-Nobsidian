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
