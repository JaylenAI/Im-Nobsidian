/**
 * S-11 — 노트의 Notion 제목은 한 규칙으로 정한다. 만들 때 · 고칠 때 · 옮길 때가 같아야 파일
 * 이름을 바꾼 것이 다음 갱신에서 옛 제목으로 되돌아가지 않는다.
 */
import { describe, it, expect } from "vitest";
import {
  explicitTitle,
  followsFileName,
  noteTitle,
  titleAfterMove,
  titleMayChange,
} from "../../src/sync/note-title.js";

describe("noteTitle — frontmatter 제목, 없으면 파일 이름", () => {
  it("frontmatter title 을 쓴다 — 파일명에 못 쓰는 글자가 있어도 원래 제목 그대로", () => {
    expect(noteTitle({ title: "A/B 통합" }, "과제/A-B 통합.md")).toBe("A/B 통합");
  });

  it("title 이 없거나 비었으면 파일 이름", () => {
    expect(noteTitle({}, "과제/과제 A.md")).toBe("과제 A");
    expect(noteTitle({ title: "  " }, "과제/과제 A.md")).toBe("과제 A");
    expect(noteTitle({ title: null }, "과제/과제 A.md")).toBe("과제 A");
  });

  it("YAML 이 숫자 · 날짜로 읽은 제목도 글로 되돌린다", () => {
    expect(noteTitle({ title: 2026 }, "x.md")).toBe("2026");
    expect(noteTitle({ title: new Date("2026-10-01T00:00:00.000Z") }, "x.md")).toBe("2026-10-01");
  });

  it("explicitTitle 은 적힌 제목만 — 없으면 null", () => {
    expect(explicitTitle({ title: "제목" })).toBe("제목");
    expect(explicitTitle({})).toBeNull();
    expect(explicitTitle({ title: "" })).toBeNull();
  });
});

describe("titleAfterMove — 옮긴 노트의 새 제목", () => {
  it("폴더만 옮기면 제목은 그대로다", () => {
    expect(titleAfterMove({}, {}, "Loose/노트.md", "Notes/노트.md", "노트")).toBeNull();
    expect(
      titleAfterMove({ title: "A/B" }, { title: "A/B" }, "x/A_B.md", "y/A_B.md", "A/B"),
    ).toBeNull();
  });

  it("이름을 바꾸면 새 파일 이름이 제목이다", () => {
    expect(titleAfterMove({}, {}, "Loose/노트.md", "Loose/새 이름.md", "노트")).toBe("새 이름");
  });

  it("행처럼 pull 이 적은 title 이 옛 파일 이름과 같으면 이름을 따라간다", () => {
    const fm = { title: "과제 A", 진척: 0.4 };
    expect(titleAfterMove(fm, fm, "Home/과제/과제 A.md", "Home/과제/과제 A2.md", "과제 A")).toBe(
      "과제 A2",
    );
  });

  it("두 번째 이름 변경도 따라간다 — frontmatter 에 남은 옛 제목이 아니라 Notion 제목과 견준다", () => {
    const fm = { title: "과제 A" };
    expect(titleAfterMove(fm, fm, "DB/과제 A2.md", "DB/과제 A3.md", "과제 A2")).toBe("과제 A3");
    expect(titleAfterMove(fm, fm, "DB/과제 A2.md", "DB/과제 A.md", "과제 A2")).toBe("과제 A");
  });

  it("파일명에 못 쓰는 글자를 바꾼 이름 · 동명 id 접미사도 pull 이 붙인 이름으로 본다", () => {
    expect(titleAfterMove({ title: "A/B" }, { title: "A/B" }, "A_B.md", "C.md", "A/B")).toBe("C");
    const fm = { title: "과제 A" };
    expect(titleAfterMove(fm, fm, "DB/과제 A (1a2b3c4d).md", "DB/과제 B.md", "과제 A")).toBe(
      "과제 B",
    );
  });

  it("파일 이름과 따로 정한 제목은 이름을 바꿔도 그대로 둔다", () => {
    const fm = { title: "2026 3분기 회의" };
    expect(titleAfterMove(fm, fm, "meeting.md", "q3.md", "2026 3분기 회의")).toBeNull();
    // Notion 에서 따로 바꾼 제목도 로컬 이름 변경이 덮지 않는다.
    expect(titleAfterMove({}, {}, "노트.md", "새 노트.md", "Notion 에서 바꾼 제목")).toBeNull();
  });

  it("title 을 고쳤으면 그것이 새 제목이다 — 이름을 같이 바꿨어도", () => {
    expect(titleAfterMove({ title: "A" }, { title: "B" }, "a.md", "b.md", "A")).toBe("B");
    expect(titleAfterMove({ title: "A" }, { title: "B" }, "x/a.md", "y/a.md", "A")).toBe("B");
  });

  it("title 을 지우고 이름을 바꾸면 새 파일 이름", () => {
    expect(titleAfterMove({ title: "X" }, {}, "x.md", "y.md", "X")).toBe("y");
  });

  it("새 제목이 Notion 의 지금 제목과 같으면 null — 보낼 것이 없다", () => {
    expect(titleAfterMove({ title: "B" }, { title: "C" }, "B.md", "sub/B.md", "C")).toBeNull();
    expect(titleAfterMove({}, {}, "노트 (1).md", "노트.md", "노트")).toBeNull();
  });

  it("지난 동기화 사본이 없으면 Notion 제목과 다르게 적힌 title 을 고친 것으로 본다", () => {
    expect(titleAfterMove(null, { title: "제목" }, "a.md", "b/a.md", "a")).toBe("제목");
    expect(titleAfterMove(null, { title: "a" }, "a.md", "b.md", "a")).toBe("b");
    expect(titleAfterMove(null, {}, "a.md", "b.md", "a")).toBe("b");
    expect(titleAfterMove(null, {}, "a.md", "b/a.md", "a")).toBeNull();
  });
});

describe("titleMayChange — Notion 제목을 읽어야 하는가", () => {
  it("이름이 같고 title 도 그대로면 읽지 않는다", () => {
    expect(titleMayChange({ title: "A" }, { title: "A" }, "x/A.md", "y/A.md")).toBe(false);
    expect(titleMayChange({}, {}, "x/A.md", "y/A.md")).toBe(false);
  });

  it("이름을 바꿨거나 title 을 고쳤으면 읽는다", () => {
    expect(titleMayChange({}, {}, "A.md", "B.md")).toBe(true);
    expect(titleMayChange({ title: "A" }, { title: "B" }, "x/A.md", "y/A.md")).toBe(true);
    expect(titleMayChange(null, { title: "A" }, "x/A.md", "y/A.md")).toBe(true);
  });
});

describe("followsFileName — pull 이 이 제목으로 그 파일 이름을 붙였는가", () => {
  it("파일 이름이 제목을 그대로 따르면 참", () => {
    expect(followsFileName("회의록", "notes/회의록.md")).toBe(true);
    expect(followsFileName("회의록", "notes/다른 이름.md")).toBe(false);
  });

  it("파일명에 못 쓰는 글자를 바꾼 이름 · 동명 충돌의 id 접미사도 따르는 것이다", () => {
    expect(followsFileName("A/B 통합", "notes/A_B 통합.md")).toBe(true);
    expect(followsFileName("회의록", "notes/회의록 (1a2b3c4d).md")).toBe(true);
    // 접미사가 id 모양이 아니면 사람이 붙인 이름이다.
    expect(followsFileName("회의록", "notes/회의록 (초안).md")).toBe(false);
  });
});
