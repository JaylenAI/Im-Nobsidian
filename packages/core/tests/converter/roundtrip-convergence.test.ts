import { describe, it, expect } from "vitest";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";

/**
 * 왕복 **수렴**을 지키는 회귀 테스트.
 *
 * 개별 변환이 옳아도 push/pull 이 서로의 역함수가 아니면, 동기화를 돌릴 때마다 파일이
 * 조금씩 달라져 사용자에게 영원히 conflict 가 뜬다. 실볼트 1,192 파일 전수 왕복에서
 * 발견된 무한 증식/잠식 4종을 각각 최소 재현형으로 고정한다.
 *
 * 판정 기준은 "1회차 결과 == 2회차 결과". 한 번의 정규화는 허용하되, 두 번째 왕복부터는
 * 반드시 고정점이어야 한다.
 */

const pipeline = createDefaultPipeline();
const ctx = (direction: "push" | "pull"): Parameters<typeof pipeline.convertToNotion>[1] => ({
  direction,
  path: "markdown-api",
  filePath: "수렴.md",
  parentMode: "page",
});

/** Obsidian → (push) → Notion Markdown → (pull) → Obsidian 한 바퀴. */
function roundTrip(source: string): string {
  const pushed = pipeline.convertToNotion(source, ctx("push")).content;
  const pulled = notionEnhancedToObsidian(obsidianToNotionEnhanced(pushed));
  return pipeline.convertToMarkdown(pulled, ctx("pull"), {}).trim();
}

/** 컨테이너 태그 계층만 검사할 때 쓰는, 전처리기 없는 한 바퀴. */
function tagRoundTrip(source: string): string {
  return notionEnhancedToObsidian(obsidianToNotionEnhanced(source)).trim();
}

describe("왕복 수렴 — 구조적 들여쓰기", () => {
  it("콜아웃 안 코드펜스는 왕복해도 탭이 늘지 않는다", () => {
    // push 가 콜아웃 본문에 구조적 탭을 입힐 때 코드 **내부** 줄까지 들여쓰면, pull 의
    // dedent 는 내부 줄을 원문 그대로 보존하므로 탭이 한 겹씩 영구히 쌓인다.
    const source = ["> [!tip] 코드 품은 콜아웃", "> ```python", '> \tprint("hello")', "> ```"].join(
      "\n",
    );

    const once = tagRoundTrip(source);

    expect(once).toBe(source);
    expect(tagRoundTrip(once)).toBe(once);
  });

  it("콜아웃 안 테이블 행도 왕복해도 탭이 늘지 않는다", () => {
    // 테이블은 코드블록과 같은 비대칭 들여쓰기 규약을 쓴다(태그만 들여쓰고 행은 열 0).
    const source = [
      "> [!note] 표 품은 콜아웃",
      "> <table>",
      "> <tr><td>값</td></tr>",
      "> </table>",
    ].join("\n");

    const once = tagRoundTrip(source);

    expect(tagRoundTrip(once)).toBe(once);
  });

  it("칼럼 안 synced block 은 왕복해도 들여쓰기가 자라지 않는다", () => {
    // pull 이 synced 마커를 열 0 에 뱉으면, 그 줄이 부모 칼럼 dedent 의 공통최소값을 0 으로
    // 끌어내려 칼럼 구조 탭이 한 겹도 벗겨지지 않는다 → push 가 매번 새로 입히는 탭이 누적.
    const url = "https://app.notion.com/p/36f13b18d382806587b2e8b7ccb303bc";
    const source = [
      "%%im-nobsidian:column-list:start%%",
      "%%im-nobsidian:column%%",
      `%%im-nobsidian:synced:start:kind=orig&url=${encodeURIComponent(url)}%%`,
      "> [!note] 프로젝트",
      "%%im-nobsidian:synced:end%%",
      "%%im-nobsidian:column-list:end%%",
    ].join("\n");

    const once = tagRoundTrip(source);
    const twice = tagRoundTrip(once);

    expect(twice).toBe(once);
    expect(twice).not.toMatch(/^\t+%%im-nobsidian:synced:start/m);
  });

  it("synced block 태그의 선행 들여쓰기는 마커 줄에도 그대로 실린다", () => {
    // 마커만 열 0 으로 떨어지면 부모 컨테이너의 dedent 기준이 무너진다.
    const url = "https://app.notion.com/p/36f13b18d382806587b2e8b7ccb303bc";
    const nfm = [
      `\t\t<synced_block url="${url}">`,
      "\t\t\t동기화 원본",
      "\t\t</synced_block>",
    ].join("\n");

    const result = notionEnhancedToObsidian(nfm);

    expect(result).toMatch(/^\t\t%%im-nobsidian:synced:start:/m);
    expect(result).toMatch(/^\t\t%%im-nobsidian:synced:end%%/m);
    expect(result).toMatch(/^\t\t동기화 원본$/m);
  });
});

describe("왕복 수렴 — 빈 줄 보존", () => {
  it("토글 뒤 문단 구분 빈 줄이 왕복마다 잠식되지 않는다", () => {
    // 토글 본문 정규식이 마지막 줄의 끝 개행까지 삼키면 `</details>` 와 다음 블록이
    // 맞붙어, 왕복 1회당 빈 줄 한 겹씩 영구히 사라진다.
    const source = ["> [!toggle]- 접힌 제목", "> 접힌 본문", "", "다음 문단"].join("\n");

    const once = tagRoundTrip(source);

    expect(once).toBe(source);
    expect(tagRoundTrip(once)).toBe(once);
  });

  it("탭 블록 뒤 문단 구분 빈 줄도 잠식되지 않는다", () => {
    const source = ["> [!tab] 첫 탭", "> 탭 본문", "", "다음 문단"].join("\n");

    const once = tagRoundTrip(source);

    expect(tagRoundTrip(once)).toBe(once);
    expect(once).toContain("다음 문단");
  });
});

describe("왕복 수렴 — 콜아웃 안 첨부 임베드", () => {
  it("콜아웃 줄을 통째로 차지한 임베드는 `>` 껍데기를 남기지 않는다", () => {
    // Notion 콜아웃 안에 첨부 블록을 넣을 수단이 없어 임베드는 콜아웃 밖으로 나간다.
    // 이때 `>` 접두사만 남기면 빈 껍데기 줄이 콜아웃에 눌러앉아, 왕복 1회차엔 남고
    // 2회차엔 사라져 파일이 영영 수렴하지 않았다.
    const source = ["> [!note] 자료", "> ![[표.base]]"].join("\n");

    const pushed = pipeline.convertToNotion(source, ctx("push")).content;

    expect(pushed).not.toMatch(/^>\s*$/m);
  });

  it("첨부 임베드를 품은 콜아웃도 2회차부터 고정점이다", () => {
    const source = ["> [!note] 자료", "> 설명 문장", "> ![[표.base]]", "", "다음 문단"].join("\n");

    const once = roundTrip(source);

    expect(roundTrip(once)).toBe(once);
  });
});

describe("왕복 수렴 — 미디어 자리표시자", () => {
  it("자리표시자 quote 는 콜아웃과 `>` 이음줄로 붙이지 않는다", () => {
    // 자리표시자는 업로드 후 제자리 교체를 위해 **독립 블록**이어야 한다. 이어 붙이면
    // 복원 뒤 이음줄 `>` 만 콜아웃 꼬리에 고아로 남는다.
    const nfm = [
      "> [!note] 설명",
      "",
      "> 📎 사진.png %%im-nobsidian:local-image:attachments/사진.png%%",
    ].join("\n");

    const result = notionEnhancedToObsidian(nfm);

    expect(result).not.toMatch(/^>$/m);
  });
});
