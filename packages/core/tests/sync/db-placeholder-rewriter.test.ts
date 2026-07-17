/**
 * 인라인 DB placeholder → .base 임베드 재작성 (F22).
 *
 * 결함: pull 이 인라인 DB 를 `**제목** *(Notion DB)*` 텍스트 한 줄로만 남겨(ID 소실)
 * 노션의 인라인 DB 뷰 경험이 볼트에서 사라졌다. 수정: 변환기가 보존 마커로 ID 를 남기고,
 * 이 재작성기가 `![[<localFolder>/<이름>.base|제목]]` Bases 임베드로 치환한다.
 * linked view 컨테이너(자체 .base 없음)는 linkedMap 해석을 resolve 콜백이 맡아
 * 원본 DB 의 .base 로 향한다.
 */
import { describe, it, expect } from "vitest";
import {
  rewriteDbPlaceholders,
  type DbEmbedTarget,
} from "../../src/sync/db-placeholder-rewriter.js";

const ID_A = "23113b18d38280f984a5c9f9161ee659";
const ID_B = "1ba13b18d38280d3af1cd851b96b04a0";

const targets = new Map<string, DbEmbedTarget>([
  [ID_A, { basePath: "세컨드 브레인/인박스/인박스.base", title: "인박스" }],
  [ID_B, { basePath: "국내주식/매매일지/매매일지.base", title: "매매일지" }],
]);
const resolve = (id: string): DbEmbedTarget | null => targets.get(id) ?? null;

function marker(id: string, title: string): string {
  return `%%im-nobsidian:child-database:id=${id}&title=${encodeURIComponent(title)}%%`;
}

describe("rewriteDbPlaceholders (F22)", () => {
  it("NFM 형 placeholder 를 .base 임베드로 치환한다(한글 인코딩 제목 포함)", () => {
    const src = `본문\n\n**인박스** *(Notion DB)*${marker(ID_A, "인박스")}\n\n다음 문단`;
    const { content, rewrites } = rewriteDbPlaceholders(src, resolve);
    expect(rewrites).toBe(1);
    expect(content).toContain("![[세컨드 브레인/인박스/인박스.base|인박스]]");
    expect(content).not.toContain("(Notion DB)");
    expect(content).not.toContain("child-database");
  });

  it("빈 제목(linked view 껍데기)은 대상 DB 제목을 별칭으로 쓴다", () => {
    const src = `**** *(Notion DB)*${marker(ID_A, "")}`;
    const { content, rewrites } = rewriteDbPlaceholders(src, resolve);
    expect(rewrites).toBe(1);
    expect(content).toBe("![[세컨드 브레인/인박스/인박스.base|인박스]]");
  });

  it("blocks-API 폴백 콜아웃 형(2줄)을 인용 접두 보존 채 치환한다", () => {
    const src = [
      "> [!database] 매매일지",
      `> ${marker(`${ID_B.slice(0, 8)}-${ID_B.slice(8, 12)}-${ID_B.slice(12, 16)}-${ID_B.slice(16, 20)}-${ID_B.slice(20)}`, "매매일지")}`,
    ].join("\n");
    const { content, rewrites } = rewriteDbPlaceholders(src, resolve);
    expect(rewrites).toBe(1);
    expect(content).toBe("> ![[국내주식/매매일지/매매일지.base|매매일지]]");
  });

  it("미해소 DB(.base 미생성)는 placeholder 와 마커를 그대로 보존한다", () => {
    const src = `**미지** *(Notion DB)*${marker("f".repeat(32), "미지")}`;
    const { content, rewrites } = rewriteDbPlaceholders(src, () => null);
    expect(rewrites).toBe(0);
    expect(content).toBe(src);
  });

  it("멱등 — 재작성 결과에 다시 돌려도 무변경이다", () => {
    const src = `**인박스** *(Notion DB)*${marker(ID_A, "인박스")}`;
    const first = rewriteDbPlaceholders(src, resolve);
    const second = rewriteDbPlaceholders(first.content, resolve);
    expect(second.rewrites).toBe(0);
    expect(second.content).toBe(first.content);
  });

  it("한 문서의 여러 placeholder 를 각자 대상으로 치환한다", () => {
    const src = [
      `**인박스** *(Notion DB)*${marker(ID_A, "인박스")}`,
      "중간 텍스트",
      `**매매일지** *(Notion DB)*${marker(ID_B, "매매일지")}`,
    ].join("\n\n");
    const { content, rewrites } = rewriteDbPlaceholders(src, resolve);
    expect(rewrites).toBe(2);
    expect(content).toContain("![[세컨드 브레인/인박스/인박스.base|인박스]]");
    expect(content).toContain("![[국내주식/매매일지/매매일지.base|매매일지]]");
  });

  it("별칭의 파이프/대괄호는 위키링크를 깨지 않게 제거된다", () => {
    const src = `**A|B[]** *(Notion DB)*${marker(ID_A, "A|B[]")}`;
    const { content } = rewriteDbPlaceholders(src, resolve);
    expect(content).toBe("![[세컨드 브레인/인박스/인박스.base|AB]]");
  });
});
