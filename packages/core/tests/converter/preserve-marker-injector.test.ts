import { describe, it, expect } from "vitest";
import { PreserveMarkerInjector } from "../../src/converter/post-processors/preserve-marker-injector.js";
import type { ProcessorInput } from "../../src/types/convert.js";

describe("PreserveMarkerInjector", () => {
  const injector = new PreserveMarkerInjector();
  const pullContext = {
    direction: "pull" as const,
    path: "markdown-api" as const,
    filePath: "test.md",
  };
  const pushContext = {
    direction: "push" as const,
    path: "markdown-api" as const,
    filePath: "test.md",
  };

  it("name이 PreserveMarkerInjector", () => {
    expect(injector.name).toBe("PreserveMarkerInjector");
  });

  it("order가 100", () => {
    expect(injector.order).toBe(100);
  });

  it("마커 없으면 콘텐츠 그대로 통과", () => {
    const input: ProcessorInput = {
      content: "# Hello\n\nWorld",
      metadata: {},
      context: pullContext,
    };
    const result = injector.process(input);
    expect(result.content).toBe("# Hello\n\nWorld");
  });

  it("push 방향에서는 아무 처리 안 함", () => {
    const input: ProcessorInput = {
      content: "# Test",
      metadata: {
        preserveMarkers: [{ type: "toggle-heading", params: { id: "abc" }, startIndex: 0 }],
      },
      context: pushContext,
    };
    const result = injector.process(input);
    expect(result.content).toBe("# Test");
  });

  it("pull 시 누락된 마커를 콘텐츠 끝에 추가", () => {
    const input: ProcessorInput = {
      content: "# Hello\n\nContent here",
      metadata: {
        preserveMarkers: [{ type: "toggle-heading", params: { id: "abc" }, startIndex: 0 }],
      },
      context: pullContext,
    };
    const result = injector.process(input);
    expect(result.content).toContain("%% im-nobsidian:toggle-heading:id=abc %%");
  });

  it("이미 존재하는 마커는 중복 추가 안 함", () => {
    const marker = "%% im-nobsidian:toggle-heading:id=abc %%";
    const input: ProcessorInput = {
      content: `# Hello\n\n${marker}\n\nContent`,
      metadata: {
        preserveMarkers: [{ type: "toggle-heading", params: { id: "abc" }, startIndex: 0 }],
      },
      context: pullContext,
    };
    const result = injector.process(input);
    const count = (result.content.match(/im-nobsidian:toggle-heading/g) || []).length;
    expect(count).toBe(1);
  });

  it("여러 마커 동시 복원 — 각자 원위치(startIndex)로", () => {
    // startIndex 는 마커를 **포함한** 원본에서의 오프셋이므로, 뒤 마커의 startIndex 는
    // 앞 마커 길이를 반영해야 물리적으로 일관된다(과거의 0/10 같은 값은 불가능한 데이터).
    const mA = "%% im-nobsidian:toggle-heading:id=a %%";
    const mB = "%% im-nobsidian:inline-db:db=tasks %%";
    const mid = "# Test\n\n본문 ";
    const original = mA + mid + mB + " 끝";
    const stripped = mid + " 끝"; // 두 마커가 제거된 상태
    const sA = 0;
    const sB = mA.length + mid.length;
    const result = injector.process({
      content: stripped,
      metadata: {
        preserveMarkers: [
          { type: "toggle-heading", params: { id: "a" }, startIndex: sA },
          { type: "inline-db", params: { db: "tasks" }, startIndex: sB },
        ],
      },
      context: pullContext,
    });
    expect(result.content).toBe(original);
  });

  // rank16(I3): 본문 **중간**에서 유실된 마커는 startIndex 기준 원위치로 복원돼야 한다.
  // 과거엔 항상 말미로 모아(append) 위치를 잃고도 '개수 보존'으로 위장했다. 변환이 마커만
  // 제거한 경우(주변 텍스트 보존) startIndex 삽입은 원본 전체 문자열을 정확히 재구성한다.
  it("본문 중간 유실 마커를 startIndex 원위치로 복원(말미 모으기 아님)", () => {
    // formatMarker({type:'callout', params:{type:'tip'}}) === '%% im-nobsidian:callout:type=tip %%'
    const marker = "%% im-nobsidian:callout:type=tip %%";
    const prefix = "# 제목\n\n앞 문단입니다.\n\n";
    const suffix = "\n\n뒤 문단입니다.";
    const original = prefix + marker + suffix;
    const startIndex = prefix.length; // 마커의 원래 위치(중간)
    // 변환이 마커만 제거한 상태(위치 손실):
    const stripped = prefix + suffix;

    const result = injector.process({
      content: stripped,
      metadata: {
        preserveMarkers: [{ type: "callout", params: { type: "tip" }, startIndex }],
      },
      context: pullContext,
    });

    // 말미가 아니라 원래 중간 위치로 복원 → 전체 문자열이 원본과 정확히 일치.
    expect(result.content).toBe(original);
  });

  it("여러 중간 마커를 각자 startIndex 원위치로 복원", () => {
    const m1 = "%% im-nobsidian:callout:type=tip %%";
    const m2 = "%% im-nobsidian:underline:x=1 %%";
    const a = "시작 ";
    const b = " 중간 ";
    const c = " 끝";
    const original = a + m1 + b + m2 + c;
    const stripped = a + b + c;
    const s1 = a.length;
    const s2 = (a + m1 + b).length; // 원본(마커 포함) 기준 두 번째 마커 위치

    const result = injector.process({
      content: stripped,
      metadata: {
        preserveMarkers: [
          { type: "callout", params: { type: "tip" }, startIndex: s1 },
          { type: "underline", params: { x: "1" }, startIndex: s2 },
        ],
      },
      context: pullContext,
    });

    expect(result.content).toBe(original);
  });

  it("빈 문자열 처리", () => {
    const input: ProcessorInput = { content: "", metadata: {}, context: pullContext };
    const result = injector.process(input);
    expect(result.content).toBe("");
  });

  it("메타데이터 보존", () => {
    const input: ProcessorInput = {
      content: "test",
      metadata: { properties: { title: "hi" } },
      context: pullContext,
    };
    const result = injector.process(input);
    expect(result.metadata.properties).toEqual({ title: "hi" });
  });
});
