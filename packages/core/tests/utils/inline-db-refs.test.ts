/**
 * 인라인 DB 참조 추출 (F22) — PARA 5개 미발견 회귀 잠금.
 *
 * 결함: collectInlineDbRefs 가 `url="https://www.notion.so/<id>"` 만 매칭했는데, 실측
 * (2026-07, 세컨드 브레인 페이지 NFM)에서 콜아웃 내부 인라인 DB 는
 * `url="https://app.notion.com/p/<id>"` 로 렌더돼 정규식이 0건 매칭 → 발견 자체 누락.
 * 수정: 호스트 비고정(32-hex 만 취득) + blocks-API 폴백 마커 겸용.
 */
import { describe, it, expect } from "vitest";
import { extractInlineDbIds } from "../../src/utils/inline-db-refs.js";

const ID_A = "23113b18d38280f984a5c9f9161ee659";
const ID_B = "1ba13b18d38280d3af1cd851b96b04a0";

describe("extractInlineDbIds (F22)", () => {
  it("신형 app.notion.com/p 호스트를 잡는다 — PARA 미발견의 원인", () => {
    const md = `> [!NOTE] PARA\n> <database url="https://app.notion.com/p/${ID_A}" inline="true" data-source-url="collection://23113b18-d382-80f9-84a5-c9f9161ee659">인박스</database>`;
    expect(extractInlineDbIds(md)).toEqual([ID_A]);
  });

  it("기존 www.notion.so 호스트도 계속 잡는다", () => {
    const md = `<database url="https://www.notion.so/${ID_B}" inline="true">스킬</database>`;
    expect(extractInlineDbIds(md)).toEqual([ID_B]);
  });

  it("blocks-API 폴백의 child-database 보존 마커를 잡는다(하이픈 제거)", () => {
    const md = `> [!database] 매매일지\n> %%im-nobsidian:child-database:id=23113b18-d382-80f9-84a5-c9f9161ee659&title=%EB%A7%A4%EB%A7%A4%%`;
    expect(extractInlineDbIds(md)).toEqual([ID_A]);
  });

  it("같은 DB 의 태그·마커 중복은 1건으로 디듀프한다", () => {
    const md = [
      `<database url="https://app.notion.com/p/${ID_A}">A</database>`,
      `<database url="https://www.notion.so/${ID_A}">A</database>`,
      `%%im-nobsidian:child-database:id=${ID_A}&title=A%%`,
      `<database url="https://www.notion.so/${ID_B}">B</database>`,
    ].join("\n");
    expect(extractInlineDbIds(md).sort()).toEqual([ID_B, ID_A].sort());
  });

  it("url 없는 database 태그·일반 텍스트에서는 아무것도 잡지 않는다", () => {
    const md = `<database inline="true">이름뿐</database>\n본문 https://www.notion.so/ 링크`;
    expect(extractInlineDbIds(md)).toEqual([]);
  });
});
