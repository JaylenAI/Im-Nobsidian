/**
 * 원격이 우리가 본 뒤에 바뀌었는지 가르는 규칙(N-05).
 *
 * Notion 은 수정 시각을 분 단위로 자른다 — 같은 분 안의 편집은 시각이 같다. 그래서 시각과 함께
 * 편집자 · 본 때를 적고, 그래도 가를 수 없으면 «확인 안 됨» 으로 내용(본문 지문)을 견준다.
 */
import { describe, it, expect } from "vitest";
import {
  CLOCK_SKEW_MARGIN_MS,
  compareRemote,
  EDIT_TIME_RESOLUTION_MS,
  isSettled,
  observationOf,
  observedRecordFields,
  remoteBodyFingerprint,
  remoteStampOf,
} from "../../src/sync/remote-observation.js";

const T = "2026-09-01T10:00:00.000Z";
const BOT = "bot-user-id";
const HUMAN = "human-user-id";
/** T 의 분이 끝나고 시계 오차만큼 더 지난 때 — 이때부터 가라앉았다. */
const SETTLED_AT = new Date(
  Date.parse(T) + EDIT_TIME_RESOLUTION_MS + CLOCK_SKEW_MARGIN_MS,
).toISOString();

describe("isSettled", () => {
  it("그 분이 끝나고 시계 오차만큼 더 지나야 가라앉는다", () => {
    expect(isSettled(T, new Date(Date.parse(SETTLED_AT) - 1).toISOString())).toBe(false);
    expect(isSettled(T, SETTLED_AT)).toBe(true);
  });

  it("모르는 값이나 읽을 수 없는 값이면 가라앉지 않았다", () => {
    expect(isSettled(null, SETTLED_AT)).toBe(false);
    expect(isSettled(T, null)).toBe(false);
    expect(isSettled("not-a-time", SETTLED_AT)).toBe(false);
  });
});

describe("compareRemote", () => {
  const record = (overrides: Partial<Parameters<typeof compareRemote>[0]> = {}) => ({
    notionLastEdited: T,
    notionLastEditedBy: HUMAN,
    notionSeenAt: "2026-09-01T10:00:30.000Z",
    ...overrides,
  });
  const page = (editor: string | null = HUMAN, lastEdited = T) => ({
    last_edited_time: lastEdited,
    last_edited_by: editor === null ? null : { id: editor },
  });

  it("수정 시각이 다르면 바뀌었다", () => {
    expect(compareRemote(record(), page(HUMAN, "2026-09-01T10:01:00.000Z"), BOT)).toBe("changed");
  });

  it("원격을 본 적이 없으면 바뀌었다", () => {
    expect(compareRemote(record({ notionLastEdited: null }), page(), BOT)).toBe("changed");
  });

  it("편집자가 바뀌었으면 수정 시각이 같아도 바뀌었다 — 가라앉은 뒤라도", () => {
    const seen = record({ notionLastEditedBy: BOT, notionSeenAt: SETTLED_AT });

    expect(compareRemote(seen, page(HUMAN), BOT)).toBe("changed");
  });

  it("가라앉은 뒤에 봤으면 바뀌지 않았다", () => {
    expect(compareRemote(record({ notionSeenAt: SETTLED_AT }), page(), BOT)).toBe("unchanged");
  });

  it("가라앉기 전이고 사람이 마지막으로 고쳤으면 확인 안 됨", () => {
    expect(compareRemote(record(), page(), BOT)).toBe("unverified");
  });

  it("언제 봤는지 모르면 확인 안 됨", () => {
    expect(compareRemote(record({ notionSeenAt: null }), page(), BOT)).toBe("unverified");
  });

  it("우리가 쓰고 편집자가 그대로 봇이면 바뀌지 않았다", () => {
    expect(compareRemote(record({ notionLastEditedBy: BOT }), page(BOT), BOT)).toBe("unchanged");
  });

  it("봇 id 를 모르면 봇 규칙을 쓰지 않는다", () => {
    expect(compareRemote(record({ notionLastEditedBy: BOT }), page(BOT), null)).toBe("unverified");
  });

  it("편집자를 모르면 편집자로 가르지 않는다", () => {
    expect(compareRemote(record({ notionLastEditedBy: null }), page(HUMAN), BOT)).toBe(
      "unverified",
    );
    expect(compareRemote(record(), page(null), BOT)).toBe("unverified");
  });
});

describe("원격을 본 기록", () => {
  const page = { id: "page-1", last_edited_time: T, last_edited_by: { id: HUMAN, name: "x" } };

  it("observationOf — 수정 시각 · 편집자 · 본 때", () => {
    expect(observationOf(page, SETTLED_AT)).toEqual({
      lastEdited: T,
      lastEditedBy: HUMAN,
      seenAt: SETTLED_AT,
    });
    expect(observationOf({ last_edited_time: T }, null)).toEqual({
      lastEdited: T,
      lastEditedBy: null,
      seenAt: null,
    });
  });

  it("observedRecordFields — 레코드에 펼쳐 넣을 네 칸", () => {
    expect(observedRecordFields(page, SETTLED_AT, "fp")).toEqual({
      notionLastEdited: T,
      notionLastEditedBy: HUMAN,
      notionSeenAt: SETTLED_AT,
      notionBodyFingerprint: "fp",
    });
  });

  it("remoteStampOf — 판정에 쓰는 값만 남긴다", () => {
    expect(remoteStampOf(page)).toEqual({
      id: "page-1",
      last_edited_time: T,
      last_edited_by: { id: HUMAN },
    });
    expect(remoteStampOf({ id: "page-2", last_edited_time: T })).toEqual({
      id: "page-2",
      last_edited_time: T,
      last_edited_by: null,
    });
  });
});

describe("remoteBodyFingerprint", () => {
  const fp = remoteBodyFingerprint;
  const BODY = "# 제목\n\n첫 문단\n\n둘째 문단";

  it("자식 페이지 · 자식 DB 태그와 그 자리의 빈 줄은 본문이 아니다", () => {
    const withChildren = [
      "# 제목",
      "",
      "첫 문단",
      "",
      '<page url="https://www.notion.so/0123456789abcdef0123456789abcdef">자식</page>',
      "",
      '<database url="https://www.notion.so/fedcba9876543210fedcba9876543210" inline="true">표</database>',
      "",
      "둘째 문단",
    ].join("\n");

    expect(fp(withChildren)).toBe(fp(BODY));
  });

  it("Notion 이 호스팅하는 파일 URL 의 서명은 본문이 아니다 — 읽을 때마다 바뀐다", () => {
    const signed = (signature: string) =>
      `![](https://prod-files-secure.s3.us-west-2.amazonaws.com/a/b/c.png?X-Amz-Signature=${signature})`;

    expect(fp(signed("1"))).toBe(fp(signed("2")));
    expect(fp("[f](https://file.notion.so/f/f/s/x/a.pdf?table=block&expirationTimestamp=1)")).toBe(
      fp("[f](https://file.notion.so/f/f/s/x/a.pdf?table=block&expirationTimestamp=2)"),
    );
  });

  it("다른 URL 의 쿼리는 본문이다", () => {
    expect(fp("[a](https://example.com/a?x=1)")).not.toBe(fp("[a](https://example.com/a?x=2)"));
  });

  it("줄 끝 공백 · 빈 줄 수 · 앞뒤 공백은 본문이 아니다", () => {
    expect(fp("\n# 제목  \n\n\n첫 문단\n\n둘째 문단\n\n")).toBe(fp(BODY));
  });

  it("글이 다르면 지문이 다르다", () => {
    expect(fp(`${BODY}\n\n셋째 문단`)).not.toBe(fp(BODY));
    expect(fp(BODY.replace("첫", "첫째"))).not.toBe(fp(BODY));
  });
});
