/**
 * 아이콘 · 커버 ↔ frontmatter 값. 2026-10-23 실측: Notion 아이콘은 색을 빼면 회색, 모르는 이름 · 색은 400.
 */
import { describe, expect, it } from "vitest";
import {
  coverSource,
  iconSource,
  iconValueOf,
  isDecorationValue,
} from "../../src/notion/decoration-values.js";

describe("받은 아이콘 → frontmatter", () => {
  it("이모지 · Notion 아이콘(색) · 사용자 이모지 · 외부 · 올린 파일", () => {
    expect(iconValueOf({ type: "emoji", emoji: "🥑" })).toEqual({ value: "🥑", uploaded: false });
    expect(iconValueOf({ type: "icon", icon: { name: "star", color: "yellow" } })?.value).toBe(
      "star:yellow",
    );
    expect(iconValueOf({ type: "icon", icon: { name: "home", color: "gray" } })?.value).toBe(
      "home",
    );
    expect(
      iconValueOf({ type: "custom_emoji", custom_emoji: { id: "e", name: "bufo" } })?.value,
    ).toBe(":bufo:");
    expect(iconValueOf({ type: "external", external: { url: "https://x.example/i.png" } })).toEqual(
      { value: "https://x.example/i.png", uploaded: false },
    );
    expect(iconValueOf({ type: "file", file: { url: "https://file.notion.so/f/f/a" } })).toEqual({
      value: "https://file.notion.so/f/f/a",
      uploaded: true,
    });
    expect(iconValueOf(null)).toBeNull();
    expect(iconValueOf({ type: "unknown" })).toBeNull();
  });
});

describe("frontmatter → 보낼 아이콘", () => {
  it("받은 꼴을 그대로 되돌린다", () => {
    expect(iconSource("🥑")).toEqual({ kind: "request", request: { type: "emoji", emoji: "🥑" } });
    expect(iconSource("🇯🇵")).toMatchObject({ request: { type: "emoji", emoji: "🇯🇵" } });
    expect(iconSource("👩‍💻")).toMatchObject({ request: { type: "emoji" } });
    expect(iconSource("star:yellow")).toEqual({
      kind: "request",
      request: { type: "icon", icon: { name: "star", color: "yellow" } },
    });
    expect(iconSource("home")).toEqual({
      kind: "request",
      request: { type: "icon", icon: { name: "home", color: "gray" } },
    });
    expect(iconSource("star circle")).toMatchObject({
      request: { icon: { name: "star circle", color: "gray" } },
    });
    expect(iconSource(":bufo:")).toEqual({ kind: "custom-emoji", name: "bufo" });
    expect(iconSource("https://x.example/i.png")).toEqual({
      kind: "request",
      request: { type: "external", external: { url: "https://x.example/i.png" } },
    });
    expect(iconSource("[[attachments/a-icon.png]]")).toEqual({
      kind: "local",
      target: "attachments/a-icon.png",
    });
  });

  it("Notion 에 올린 파일의 서명 주소는 다시 보낼 수 없다", () => {
    expect(
      iconSource("https://prod-files-secure.s3.us-west-2.amazonaws.com/a/b/i.png?X=1"),
    ).toEqual({ kind: "hosted" });
  });

  it("비었으면 지우고, 모르는 색 · 읽을 수 없는 값은 보내지 않는다", () => {
    expect(iconSource("")).toEqual({ kind: "clear" });
    expect(iconSource(null)).toEqual({ kind: "clear" });
    expect(iconSource("star:neon")).toMatchObject({ kind: "invalid" });
    expect(iconSource("a/b?")).toMatchObject({ kind: "invalid" });
  });
});

describe("frontmatter → 보낼 커버", () => {
  it("외부 주소 · 볼트 파일만", () => {
    expect(coverSource("https://img.example/c.jpg")).toEqual({
      kind: "request",
      request: { type: "external", external: { url: "https://img.example/c.jpg" } },
    });
    expect(coverSource("![[c.png|300]]")).toEqual({ kind: "local", target: "c.png" });
    expect(coverSource("표지")).toMatchObject({ kind: "invalid" });
    expect(coverSource(undefined)).toEqual({ kind: "clear" });
  });

  it("아이콘 · 커버로 읽을 수 있는 값만 속성 블록에서 뺀다", () => {
    expect(isDecorationValue("icon", "🥑")).toBe(true);
    expect(isDecorationValue("cover", "표지")).toBe(false);
    expect(isDecorationValue("icon", "")).toBe(false);
  });
});
