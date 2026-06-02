import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import { resolveFrontmatterRelations } from "../../src/sync/frontmatter-link-resolver.js";

// 실제 pull 결과(듀얼 브레인.md)와 동일한 형식: relation 은 YAML 리스트 항목, 값은 대시 UUID
const REAL = `---
작가:
  - 1c013b18-d382-8377-9e12-81ab4578b0b9
옮긴이:
  - 6d913b18-d382-82a0-85d3-81640ab11988
원제: null
가격: 18900
평가: ⭐⭐⭐⭐
title: 듀얼 브레인
---

본문 내용은 그대로 보존되어야 한다.
`;

function idMap(entries: Array<[string, string]>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [id, title] of entries) {
    m.set(id, title);
    m.set(id.replace(/-/g, ""), title);
  }
  return m;
}

describe("resolveFrontmatterRelations", () => {
  it("relation UUID(대시) → [[제목]] 치환, 미해소·비relation 필드는 보존", () => {
    const map = idMap([
      ["1c013b18-d382-8377-9e12-81ab4578b0b9", "이선 몰릭"],
      // 옮긴이 6d91... 은 일부러 미등록 → 무손실로 남아야 함
    ]);
    const { content, count } = resolveFrontmatterRelations(REAL, map);
    expect(count).toBe(1);

    const parsed = matter(content);
    expect(parsed.data["작가"]).toEqual(["[[이선 몰릭]]"]);
    // 미해소 relation 은 원시 UUID 그대로
    expect(parsed.data["옮긴이"]).toEqual(["6d913b18-d382-82a0-85d3-81640ab11988"]);
    // 비-relation 필드 보존
    expect(parsed.data["원제"]).toBeNull();
    expect(parsed.data["가격"]).toBe(18900);
    expect(parsed.data["평가"]).toBe("⭐⭐⭐⭐");
    expect(parsed.data["title"]).toBe("듀얼 브레인");
    // 본문 보존
    expect(parsed.content.trim()).toBe("본문 내용은 그대로 보존되어야 한다.");
  });

  it("대시 없는 32hex UUID 와 다중 relation 모두 해소", () => {
    // 1c013b18-d382-8377-9e12-81ab4578b0b9 의 대시 제거형(정확히 32 hex)
    const input = `---
작가:
  - 1c013b18d38283779e1281ab4578b0b9
  - 6d913b18-d382-82a0-85d3-81640ab11988
스칼라관계: 7a913b18-d382-836d-8ec2-81c1014dd7cc
---
body
`;
    const map = idMap([
      ["1c013b18-d382-8377-9e12-81ab4578b0b9", "A"],
      ["6d913b18-d382-82a0-85d3-81640ab11988", "B"],
      ["7a913b18-d382-836d-8ec2-81c1014dd7cc", "C"],
    ]);
    const { content, count } = resolveFrontmatterRelations(input, map);
    expect(count).toBe(3);
    const parsed = matter(content);
    expect(parsed.data["작가"]).toEqual(["[[A]]", "[[B]]"]);
    expect(parsed.data["스칼라관계"]).toBe("[[C]]");
  });

  it("해소 대상 0 이면 원본 content 를 그대로 반환(재직렬화·churn 없음)", () => {
    const map = idMap([["00000000-0000-0000-0000-000000000000", "없는것"]]);
    const { content, count } = resolveFrontmatterRelations(REAL, map);
    expect(count).toBe(0);
    expect(content).toBe(REAL);
  });

  it("frontmatter 없는 본문은 그대로 통과", () => {
    const plain = "frontmatter 없는 일반 본문\n";
    const { content, count } = resolveFrontmatterRelations(plain, idMap([["a", "b"]]));
    expect(count).toBe(0);
    expect(content).toBe(plain);
  });

  it("멱등성: 이미 해소된 결과를 재실행하면 변화 없음", () => {
    const map = idMap([
      ["1c013b18-d382-8377-9e12-81ab4578b0b9", "이선 몰릭"],
      ["6d913b18-d382-82a0-85d3-81640ab11988", "박옮김"],
    ]);
    const first = resolveFrontmatterRelations(REAL, map);
    expect(first.count).toBe(2);
    const second = resolveFrontmatterRelations(first.content, map);
    expect(second.count).toBe(0);
    expect(second.content).toBe(first.content);
  });
});
