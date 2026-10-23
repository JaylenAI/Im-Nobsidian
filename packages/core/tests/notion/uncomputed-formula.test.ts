/**
 * API 가 계산하지 못한 수식 · 롤업(2026-08-05 changelog) — 값이 `{ type: "unsupported", unsupported: {} }` 로 온다.
 * 그대로 적으면 노트에 `수식: {}` 가 남았다.
 */
import { describe, expect, it } from "vitest";
import { PropertyMapper } from "../../src/notion/property-mapper.js";

describe("계산하지 못한 수식 · 롤업", () => {
  it("값을 적지 않는다", () => {
    const props = new PropertyMapper().fromNotionProperties({
      수식: { id: "f", type: "formula", formula: { type: "unsupported", unsupported: {} } },
      롤업: {
        id: "r",
        type: "rollup",
        rollup: { type: "unsupported", unsupported: {}, function: "sum" },
      },
      계산됨: { id: "c", type: "formula", formula: { type: "number", number: 3 } },
    });
    expect(props.수식).toBeNull();
    expect(props.롤업).toBeNull();
    expect(props.계산됨).toBe(3);
  });
});
