import { describe, it, expect } from "vitest";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";

// 실측 근거(P3): NFM raw 의 내부 미디어는 `<video src="file://{json}">` 형태다(JSON 에
// attachment source + permissionRecord.block id). 이 태그를 replace 로 되밀면 블록이
// 동일 id 로 보존되지만, md 링크(`[🎬 video](file://…)`)로 되밀면 video 블록이
// paragraph 로 파괴되고 URL 까지 소실된다. 따라서 push 의 restoreMediaTags 가
// file:// URI 링크를 반드시 태그로 복원해야 한다 — 이 왕복을 회귀 가드로 고정한다.
// (100MB 초과 파일은 pull 이 다운로드를 건너뛰어 이 링크 형태가 vault 에 남는다.)

// 실 볼트(240722 AIIO)에서 채취한 실측 URI 축약본 — %7B/%7D(JSON)·%3A(콜론) 인코딩 유지
const FILE_JSON_URI =
  "file://%7B%22source%22%3A%22attachment%3Ab5496747-2731-424c-89f6-e28bbdc25d58%3AAIIO_240722.mp4%22%2C%22permissionRecord%22%3A%7B%22table%22%3A%22block%22%2C%22id%22%3A%2236413b18-d382-81c9-a258-e611883af93c%22%7D%7D";

describe("내부 미디어(file://{json}) 왕복", () => {
  it("pull: <video src=file://…> → [🎬 video](file://…) 링크", () => {
    const raw = `<video src="${FILE_JSON_URI}">\n</video>`;
    const pulled = notionEnhancedToObsidian(raw);
    expect(pulled).toContain(`[🎬 video](${FILE_JSON_URI})`);
    expect(pulled).not.toContain("<video");
  });

  it("push: [🎬 video](file://…) → <video src=file://…> 태그 복원 (블록 파괴 방지)", () => {
    const pushed = obsidianToNotionEnhanced(`[🎬 video](${FILE_JSON_URI})`);
    expect(pushed).toContain(`<video src="${FILE_JSON_URI}">`);
    expect(pushed).not.toContain("[🎬");
  });

  it("왕복: raw → obsidian → raw 에서 URI 가 바이트 단위로 보존된다", () => {
    // URI 재인코딩/디코딩이 일어나면 NFM diff 가 블록을 재생성해 참조가 끊길 수 있다.
    const raw = `<video src="${FILE_JSON_URI}">\n</video>`;
    const roundtripped = obsidianToNotionEnhanced(notionEnhancedToObsidian(raw));
    expect(roundtripped).toContain(`src="${FILE_JSON_URI}"`);
  });

  it("file/pdf/audio 태그도 동일 왕복", () => {
    for (const [tag, emoji] of [
      ["file", "📎"],
      ["pdf", "📄"],
      ["audio", "🔊"],
    ] as const) {
      const raw = `<${tag} src="${FILE_JSON_URI}">보고서</${tag}>`;
      const pulled = notionEnhancedToObsidian(raw);
      expect(pulled).toContain(`[${emoji} 보고서](${FILE_JSON_URI})`);
      const pushed = obsidianToNotionEnhanced(pulled);
      expect(pushed).toContain(`<${tag} src="${FILE_JSON_URI}">보고서</${tag}>`);
    }
  });

  it("일반 외부 URL 미디어 링크도 태그로 복원 (기존 동작 유지)", () => {
    const pushed = obsidianToNotionEnhanced("[🎬 데모](https://example.com/demo.mp4)");
    expect(pushed).toContain('<video src="https://example.com/demo.mp4">데모</video>');
  });
});
