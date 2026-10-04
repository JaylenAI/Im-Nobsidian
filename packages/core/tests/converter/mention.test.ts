/**
 * F-01 · F-02 — Notion 멘션(사용자 · 날짜 · DB · 데이터 소스 · 에이전트)의 볼트 왕복.
 *
 * Markdown API 는 멘션을 이름 없는 태그로 내보낸다(2026-09-26 실측 모양을 그대로 쓴다). 예전 pull 은
 * 사용자 멘션 태그를 볼트에 그대로 남기고 날짜는 시작 날짜만 평문으로 남겨, 다음 push 가 Notion 쪽
 * 멘션까지 평문으로 바꿨다. 보이는 글을 짝 마커로 감싸 원래 속성을 싣고 push 가 되살린다.
 */
import { describe, it, expect } from "vitest";
import {
  dateMentionLabel,
  markersToMentions,
  mentionsToMarkers,
  mentionUserIds,
  parseDateMentionLabel,
  stripMentionMarkers,
} from "../../src/converter/mention.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";

const USER = "3e713b18-d382-81d3-943f-cd5c5d041fcd";
const USER_TAG = `<mention-user url="user://${USER}"/>`;
const USER_MARKER = (label: string) =>
  `%%im-nobsidian:mention-user:url=user%3A%2F%2F${USER}%%${label}%%/mention%%`;
const NAMES = new Map([[USER, "한지수"]]);

/** 실측 — 기간 + 시각, 시간대를 안 고른 멘션은 오프셋이 Etc 시간대로 온다. */
const RANGE_TAG =
  '<mention-date start="2026-09-26" startTime="09:00" end="2026-09-27" endTime="18:00" timeZone="Etc/GMT-9"/>';
/** 실측 — 시간대를 고른 멘션. */
const ZONED_TAG = '<mention-date start="2026-10-01" startTime="14:00" timeZone="Asia/Seoul"/>';

describe("pull — 멘션 태그를 짝 마커로", () => {
  it("사용자 멘션은 받은 이름을 @이름 으로 보이고 id 를 싣는다", () => {
    expect(mentionsToMarkers(`담당: ${USER_TAG} 확인`, NAMES)).toBe(
      `담당: ${USER_MARKER("@한지수")} 확인`,
    );
  });

  it("이름을 모르면 @user 로 보인다 — 멘션은 id 로 그대로 남는다", () => {
    expect(mentionsToMarkers(USER_TAG)).toBe(USER_MARKER("@user"));
  });

  it("태그 안의 이름이 있으면 그 이름을 쓴다 — 받은 이름보다 앞선다", () => {
    expect(mentionsToMarkers(`<mention-user url="user://${USER}">Ada</mention-user>`, NAMES)).toBe(
      USER_MARKER("@Ada"),
    );
  });

  it("날짜 멘션은 시각 · 끝 · 시간대를 모두 보인다 — Etc/GMT-9 는 UTC+9 다", () => {
    expect(notionEnhancedToObsidian(RANGE_TAG)).toBe(
      "%%im-nobsidian:mention-date:start=2026-09-26&startTime=09%3A00&end=2026-09-27&endTime=18%3A00&timeZone=Etc%2FGMT-9%%" +
        "2026-09-26 09:00 → 2026-09-27 18:00 (UTC+9)%%/mention%%",
    );
    expect(notionEnhancedToObsidian(ZONED_TAG)).toContain(
      "%%2026-10-01 14:00 (Asia/Seoul)%%/mention%%",
    );
  });

  it("짝 태그(`…></mention-date>`)도 같은 마커가 된다", () => {
    expect(mentionsToMarkers('<mention-date start="2026-07-28"></mention-date>')).toBe(
      "%%im-nobsidian:mention-date:start=2026-07-28%%2026-07-28%%/mention%%",
    );
  });

  it("DB · 데이터 소스 · 에이전트 멘션은 안의 이름을 보인다", () => {
    const url = "https://www.notion.so/1234abcd5678efab9012cdef34567890";
    expect(mentionsToMarkers(`<mention-database url="${url}">할 일</mention-database>`)).toBe(
      `%%im-nobsidian:mention-database:url=${encodeURIComponent(url)}%%할 일%%/mention%%`,
    );
    expect(mentionsToMarkers(`<mention-agent url="${url}"/>`)).toContain("%%Notion agent%%");
  });

  it("코드 안의 태그는 사용자가 적은 글자라 그대로 둔다", () => {
    const md = `\`${USER_TAG}\`\n\n\`\`\`html\n${RANGE_TAG}\n\`\`\``;
    expect(mentionsToMarkers(md, NAMES)).toBe(md);
  });

  it("이름에 줄바꿈 · `%%` 가 있어도 마커 한 줄을 깨지 않는다", () => {
    const names = new Map([[USER, "이름%%\n둘째 줄"]]);
    expect(mentionsToMarkers(USER_TAG, names)).toBe(USER_MARKER("@이름% 둘째 줄"));
  });
});

describe("mentionUserIds — 이름을 물을 사용자", () => {
  it("이름 없는 사용자 멘션의 id 만 한 번씩 모은다", () => {
    const md = [
      USER_TAG,
      USER_TAG,
      '<mention-user url="user://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">이름 있음</mention-user>',
      '`<mention-user url="user://ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"/>`',
      '<mention-user url="user://not-an-id"/>',
      RANGE_TAG,
    ].join("\n");
    expect(mentionUserIds(md)).toEqual([USER]);
  });
});

describe("push — 짝 마커를 멘션 태그로", () => {
  it("고치지 않은 날짜는 받은 속성 그대로 되돌린다", () => {
    for (const tag of [RANGE_TAG, ZONED_TAG, '<mention-date start="2026-05-13"/>']) {
      expect(obsidianToNotionEnhanced(notionEnhancedToObsidian(tag))).toBe(tag);
    }
  });

  it("사용자는 id 로 되돌리고 보이는 이름을 안에 싣는다", () => {
    expect(markersToMentions(USER_MARKER("@한지수"))).toBe(
      `<mention-user url="user://${USER}">한지수</mention-user>`,
    );
    expect(markersToMentions(USER_MARKER("@user"))).toBe(USER_TAG);
  });

  it("보이는 글을 지우면 멘션도 지운 것이다", () => {
    expect(markersToMentions(`앞 ${USER_MARKER("")} 뒤`)).toBe("앞  뒤");
  });

  it("날짜 글을 고치면 고친 날짜로 새 멘션을 만든다 — 시간대는 글에 적힌 대로", () => {
    const pulled = notionEnhancedToObsidian(RANGE_TAG);
    const edited = pulled.replace(
      "2026-09-26 09:00 → 2026-09-27 18:00 (UTC+9)",
      "2026-09-28 10:30 → 2026-09-29 12:00 (UTC+9)",
    );
    expect(markersToMentions(edited)).toBe(
      '<mention-date start="2026-09-28" startTime="10:30" end="2026-09-29" endTime="12:00" timeZone="Etc/GMT-9"/>',
    );
  });

  it("고친 글에서 시간대를 지우면 시간대 없는 멘션이 된다", () => {
    const pulled = notionEnhancedToObsidian(ZONED_TAG);
    expect(markersToMentions(pulled.replace("2026-10-01 14:00 (Asia/Seoul)", "2026-10-02"))).toBe(
      '<mention-date start="2026-10-02"/>',
    );
  });

  it("날짜로 읽지 못하는 글 · 없는 날짜는 글로 보낸다 — 멘션을 글로 바꾼 것이다", () => {
    const pulled = notionEnhancedToObsidian('<mention-date start="2026-05-13"/>');
    expect(markersToMentions(pulled.replace("%%2026-05-13%%", "%%다음 주 화요일%%"))).toBe(
      "다음 주 화요일",
    );
    expect(markersToMentions(pulled.replace("%%2026-05-13%%", "%%2026-02-30%%"))).toBe(
      "2026-02-30",
    );
  });

  it("DB 멘션은 안의 이름과 함께 되돌린다", () => {
    const tag =
      '<mention-database url="https://www.notion.so/1234abcd5678efab9012cdef34567890">할 일</mention-database>';
    expect(obsidianToNotionEnhanced(notionEnhancedToObsidian(tag))).toBe(tag);
  });

  it("속성 값의 `&` · `=` · `;` 도 왕복한다", () => {
    const tag =
      '<mention-agent url="https://example.com/a?x=1&amp;y=&quot;2&quot;">봇</mention-agent>';
    expect(obsidianToNotionEnhanced(notionEnhancedToObsidian(tag))).toBe(tag);
  });

  it("색 안의 멘션도 둘 다 되살린다", () => {
    const md = `<span color="red">${RANGE_TAG}</span>`;
    expect(obsidianToNotionEnhanced(notionEnhancedToObsidian(md))).toBe(md);
  });

  it("코드 안의 마커는 그대로 둔다", () => {
    const md = `\`${USER_MARKER("@한지수")}\``;
    expect(markersToMentions(md)).toBe(md);
  });
});

describe("날짜 글", () => {
  it.each([
    [[["start", "2026-09-26"]], "2026-09-26"],
    [
      [
        ["start", "2026-09-26"],
        ["end", "2026-09-27"],
      ],
      "2026-09-26 → 2026-09-27",
    ],
    [
      [
        ["start", "2026-09-26"],
        ["startTime", "09:00"],
        ["endTime", "18:00"],
        ["timeZone", "Etc/GMT+5"],
      ],
      "2026-09-26 09:00 → 18:00 (UTC-5)",
    ],
  ] as const)("%j → %s", (attrs, label) => {
    expect(dateMentionLabel(attrs)).toBe(label);
    expect(parseDateMentionLabel(label)).not.toBeNull();
  });

  it("`->` 도 화살표로 읽는다", () => {
    expect(parseDateMentionLabel("2026-09-26 -> 2026-09-27")).toEqual({
      start: "2026-09-26",
      end: "2026-09-27",
    });
  });

  it("끝에 시각만 적으면 같은 날 끝이다", () => {
    expect(parseDateMentionLabel("2026-09-26 09:00 → 18:00 (UTC+9)")).toEqual({
      start: "2026-09-26",
      startTime: "09:00",
      end: "2026-09-26",
      endTime: "18:00",
      timeZone: "Etc/GMT-9",
    });
  });

  it("시각이 없으면 시간대를 버린다", () => {
    expect(parseDateMentionLabel("2026-10-02 (Asia/Seoul)")).toEqual({ start: "2026-10-02" });
  });

  it.each([
    "2026-13-01",
    "2026-09-26 24:00",
    "2026-09-26 09:00 (Mars/Base)",
    "어제",
    "2026-09-26 →",
    "2026-09-27 → 2026-09-26",
    "2026-09-26 18:00 → 09:00",
    "2026-09-26 09:00 → 2026-09-27",
    "2026-09-26 → 18:00",
  ])("%s → 읽지 못한다", (label) => {
    expect(parseDateMentionLabel(label)).toBeNull();
  });
});

describe("stripMentionMarkers — 블록 방식 push", () => {
  it("마커를 걷고 보이는 글만 남긴다", () => {
    expect(stripMentionMarkers(`담당 ${USER_MARKER("@한지수")} 님`)).toBe("담당 @한지수 님");
  });
});
