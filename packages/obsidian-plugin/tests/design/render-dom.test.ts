// @vitest-environment happy-dom
/**
 * 읽기 보기 칠하기 (U-01) — 픽스처는 Obsidian 1.13.7 이 디자인 노트를 그린 섹션 DOM 그대로다
 * (플러그인을 끄고 떠 왔다 · 아이콘 SVG 만 비움). 마커는 그리기 전에 지워져 DOM 에 없다.
 */
import { describe, it, expect } from "vitest";
import { decorateRendered } from "../../src/design/render-dom.js";

const OPTIONS = { calloutColorIsCss: true };

/** 섹션 하나 — 후처리기가 받는 `el` 은 블록을 감싼 div 다. */
function section(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

/** 칠해진 span 들을 `클래스:글` 로. */
function painted(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll("span[class*=im-nobsidian-]")).map(
    (span) => `${span.className}:${span.textContent}`,
  );
}

const CALLOUT = (type: string, title: string, fold = ""): string =>
  `<div data-callout-metadata="" data-callout-fold="${fold}" data-callout="${type}" class="callout"><div class="callout-title" dir="auto"><div class="callout-icon"><svg></svg></div><div class="callout-title-inner">${title}</div></div></div>`;

describe("decorateRendered — 글 단위", () => {
  it("짝 마커 사이 글만 칠하고, 보이는 글은 그대로다", () => {
    const el = section(`<p dir="auto">A1 빨간 글자 와 기본 글자</p>`);
    decorateRendered(
      el,
      ["A1 %%im-nobsidian:color:red%%빨간 글자%%/color%% 와 기본 글자"],
      OPTIONS,
    );

    expect(painted(el)).toEqual(["im-nobsidian-color-red:빨간 글자"]);
    expect(el.textContent).toBe("A1 빨간 글자 와 기본 글자");
  });

  it("강조 안의 겹친 서식 · 배경 글자 — 원문의 ** · <u> 를 걷어 낸 글로 찾는다", () => {
    const el = section(
      `<p dir="auto">A4 <strong>굵게</strong> · <strong>굵게+빨강+밑줄</strong> · <u>밑줄만</u> · 노랑 배경</p>`,
    );
    decorateRendered(
      el,
      [
        "A4 **굵게** · %%im-nobsidian:color:red%%%%im-nobsidian:underline%%**굵게+빨강+밑줄**%%/underline%%%%/color%% · <u>밑줄만</u> · %%im-nobsidian:color:yellow_bg%%노랑 배경%%/color%%",
      ],
      OPTIONS,
    );

    expect(painted(el)).toEqual([
      "im-nobsidian-color-red im-nobsidian-underline:굵게+빨강+밑줄",
      "im-nobsidian-bg-yellow:노랑 배경",
    ]);
    expect(el.querySelectorAll("strong")[1]!.firstElementChild?.tagName).toBe("SPAN");
  });

  it("같은 글이 여러 번 나와도 원문 차례대로 — 첫째는 빨강, 가운데는 그대로, 셋째는 파랑", () => {
    const el = section(`<p dir="auto">A13 같은 글 반복 반복 반복</p>`);
    decorateRendered(
      el,
      [
        "A13 같은 글 %%im-nobsidian:color:red%%반복%%/color%% 반복 %%im-nobsidian:color:blue%%반복%%/color%%",
      ],
      OPTIONS,
    );

    expect(el.innerHTML).toBe(
      `<p dir="auto">A13 같은 글 <span class="im-nobsidian-color-red">반복</span> 반복 <span class="im-nobsidian-color-blue">반복</span></p>`,
    );
  });

  it("멘션 — 보이는 글을 멘션으로 칠한다", () => {
    const el = section(`<p dir="auto">A5 사용자: @user</p>`);
    decorateRendered(
      el,
      ["A5 사용자: %%im-nobsidian:mention-user:url=user%3A%2F%2F2e6d%%@user%%/mention%%"],
      OPTIONS,
    );
    expect(painted(el)).toEqual(["im-nobsidian-mention:@user"]);
  });

  it("인라인 코드 안의 마커 모양 글은 사용자가 적은 글자다 — 건드리지 않는다", () => {
    const html = `<p dir="auto"><code>A14 코드 속 %%im-nobsidian:color:red%%그대로%%/color%%</code></p>`;
    const el = section(html);
    decorateRendered(el, ["`A14 코드 속 %%im-nobsidian:color:red%%그대로%%/color%%`"], OPTIONS);
    expect(el.innerHTML).toBe(html);
  });

  it("색 안에 코드가 있어도 코드 앞뒤 글을 칠한다 — 코드 안은 그대로", () => {
    const el = section(`<p dir="auto">앞 빨강 <code>x</code> 끝 뒤</p>`);
    decorateRendered(el, ["앞 %%im-nobsidian:color:red%%빨강 `x` 끝%%/color%% 뒤"], OPTIONS);
    expect(painted(el)).toEqual(["im-nobsidian-color-red:빨강 ", "im-nobsidian-color-red: 끝"]);
    expect(el.querySelector("code")!.parentElement!.tagName).toBe("P");
  });

  it("원문 조각을 그려진 글에서 못 찾으면 그 조각만 건너뛴다 — 다른 글을 칠하지 않는다", () => {
    const el = section(`<p dir="auto">전혀 다른 글</p>`);
    decorateRendered(el, ["앞 %%im-nobsidian:color:red%%빨강%%/color%% 뒤"], OPTIONS);
    expect(painted(el)).toEqual([]);
  });
});

describe("decorateRendered — 블록 단위", () => {
  it("문단 · 제목 · 인용 · 목록 항목의 블록 색", () => {
    const p = section(`<p dir="auto">A2 보라 배경 문단 </p>`);
    decorateRendered(p, ["A2 보라 배경 문단 %%im-nobsidian:block-color:purple_bg%%"], OPTIONS);
    expect(p.firstElementChild!.className).toBe("im-nobsidian-block im-nobsidian-bg-purple");

    const h2 = section(
      `<h2 data-heading="A3 파란 제목" dir="auto"><span class="heading-collapse-indicator collapse-indicator collapse-icon"><svg></svg></span>A3 파란 제목 </h2>`,
    );
    decorateRendered(h2, ["## A3 파란 제목 %%im-nobsidian:block-color:blue%%"], OPTIONS);
    expect(h2.firstElementChild!.className).toBe("im-nobsidian-block im-nobsidian-color-blue");

    const quote = section(`<blockquote dir="auto">\n<p>A8 주황 인용 </p>\n</blockquote>`);
    decorateRendered(quote, ["> A8 주황 인용 %%im-nobsidian:block-color:orange_bg%%"], OPTIONS);
    expect(quote.firstElementChild!.className).toBe("im-nobsidian-block im-nobsidian-bg-orange");

    // 목록은 그 줄의 항목만 — data-line 은 섹션 첫 줄부터 센다
    const list = section(
      `<ul class="has-list-bullet">\n<li data-line="0" dir="auto"><span class="list-bullet"></span>첫째</li>\n<li data-line="1" dir="auto"><span class="list-bullet"></span>A7 초록 목록 </li>\n</ul>`,
    );
    decorateRendered(
      list,
      ["- 첫째", "- A7 초록 목록 %%im-nobsidian:block-color:green%%"],
      OPTIONS,
    );
    const items = list.querySelectorAll("li");
    expect(items[0]!.className).toBe("");
    expect(items[1]!.className).toBe("im-nobsidian-block im-nobsidian-color-green");
  });

  it("콜아웃 — 색은 --callout-color, 이모지 아이콘은 그 글자로 덮는다", () => {
    const el = section(CALLOUT("note", "A9 로켓 파랑 콜아웃 "));
    decorateRendered(
      el,
      [
        "> [!note] A9 로켓 파랑 콜아웃 %%im-nobsidian:callout-style:icon=%F0%9F%9A%80&color=blue_bg%%",
      ],
      OPTIONS,
    );
    const callout = el.querySelector<HTMLElement>(".callout")!;
    expect(callout.style.getPropertyValue("--callout-color")).toBe(
      "rgb(var(--im-nobsidian-blue-rgb))",
    );
    const icon = callout.querySelector<HTMLElement>(".callout-icon")!;
    expect(icon.className).toBe("callout-icon im-nobsidian-callout-emoji");
    expect(icon.dataset.imNobsidianEmoji).toBe("🚀");
  });

  it("1.13 전 Obsidian 은 --callout-color 에 RGB 세 값을 바란다", () => {
    const el = section(CALLOUT("warning", "경고"));
    decorateRendered(el, ["> [!warning] 경고 %%im-nobsidian:callout-style:color=red%%"], {
      calloutColorIsCss: false,
    });
    expect(
      el.querySelector<HTMLElement>(".callout")!.style.getPropertyValue("--callout-color"),
    ).toBe("var(--im-nobsidian-red-rgb)");
  });

  it("Notion 에서 아이콘을 지운 콜아웃은 아이콘을 숨기고, 마커 없는 콜아웃은 그대로 둔다", () => {
    const bare = section(CALLOUT("note", "아이콘 없음"));
    decorateRendered(bare, ["> [!note] 아이콘 없음 %%im-nobsidian:callout-style:%%"], OPTIONS);
    expect(bare.querySelector<HTMLElement>(".callout-icon")!.style.display).toBe("none");

    const html = CALLOUT("tip", "A11 기본 전구 콜아웃");
    const plain = section(html);
    decorateRendered(plain, ["> [!tip] A11 기본 전구 콜아웃"], OPTIONS);
    expect(plain.innerHTML).toBe(html);
  });

  it("토글 색은 블록 색처럼 칠한다 — 토글은 바탕 없는 모양이라 콜아웃 색이 보이지 않는다", () => {
    const el = section(CALLOUT("toggle", "A12 초록 토글 ", "-"));
    decorateRendered(
      el,
      ["> [!toggle]- A12 초록 토글 %%im-nobsidian:toggle-color:green_bg%%", "> 토글 안 글"],
      OPTIONS,
    );
    const callout = el.querySelector<HTMLElement>(".callout")!;
    expect(callout.className).toBe("callout im-nobsidian-block im-nobsidian-bg-green");
    expect(callout.style.getPropertyValue("--callout-color")).toBe("");
  });

  it("콜아웃 수가 원문과 다르면 칠하지 않는다 — 엉뚱한 콜아웃을 칠하는 것보다 낫다", () => {
    const el = section(CALLOUT("note", "하나") + CALLOUT("note", "둘"));
    decorateRendered(el, ["> [!note] 하나 %%im-nobsidian:callout-style:color=red%%"], OPTIONS);
    expect(
      el.querySelector<HTMLElement>(".callout")!.style.getPropertyValue("--callout-color"),
    ).toBe("");
  });

  it("표 — 머리 열 · 행 색 · 셀 색, 셀 안의 글자색", () => {
    const el = section(
      `<table>\n<thead>\n<tr>\n<th dir="ltr">항목</th>\n<th dir="ltr">값</th>\n<th dir="ltr">비고</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td dir="ltr"><strong>굵게</strong></td>\n<td dir="ltr">빨강</td>\n<td dir="ltr"><a class="external-link" href="#">링크</a></td>\n</tr>\n</tbody>\n</table>`,
    );
    decorateRendered(
      el,
      [
        "| %%im-nobsidian:table:header-row=true&header-column=true%%%%im-nobsidian:table-row:color=blue_bg%%항목 | 값 | 비고 |",
        "| --- | --- | --- |",
        "| **굵게** | %%im-nobsidian:table-cell:color=red_bg%%%%im-nobsidian:color:red%%빨강%%/color%% | [링크](#) |",
      ],
      OPTIONS,
    );
    const cells = Array.from(el.querySelectorAll("th, td")).map((c) => c.className);
    expect(cells).toEqual([
      "im-nobsidian-table-header-column im-nobsidian-bg-blue",
      "im-nobsidian-bg-blue",
      "im-nobsidian-bg-blue",
      "im-nobsidian-table-header-column",
      "im-nobsidian-bg-red",
      "",
    ]);
    expect(painted(el)).toEqual(["im-nobsidian-color-red:빨강"]);
    expect(el.querySelector("table")!.className).toBe("");
  });

  it("머리 행이 없는 Notion 표는 머리 행 모양을 걷는다 · 열 색은 그 열 전체", () => {
    const el = section(
      `<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>c</td><td>d</td></tr></tbody></table>`,
    );
    decorateRendered(
      el,
      [
        "| %%im-nobsidian:table:header-row=false%%a | %%im-nobsidian:table-col:width=120&color=green%%b |",
        "| --- | --- |",
        "| c | d |",
      ],
      OPTIONS,
    );
    expect(el.querySelector("table")!.className).toBe("im-nobsidian-table-no-header-row");
    expect(Array.from(el.querySelectorAll("th, td")).map((c) => c.className)).toEqual([
      "",
      "im-nobsidian-color-green",
      "",
      "im-nobsidian-color-green",
    ]);
  });

  it("겹치면 좁은 쪽이 이긴다 — 셀 색 > 행 색 > 열 색", () => {
    const el = section(
      `<table><thead><tr><th>a</th><th>b</th><th>c</th></tr></thead><tbody><tr><td>d</td><td>e</td><td>f</td></tr></tbody></table>`,
    );
    decorateRendered(
      el,
      [
        "| a | b | %%im-nobsidian:table-col:color=green%%c |",
        "| --- | --- | --- |",
        "| %%im-nobsidian:table-row:color=yellow_bg%%%%im-nobsidian:table-cell:color=red%%d | e | f |",
      ],
      OPTIONS,
    );
    expect(Array.from(el.querySelectorAll("td")).map((c) => c.className)).toEqual([
      "im-nobsidian-color-red",
      "im-nobsidian-bg-yellow",
      "im-nobsidian-bg-yellow",
    ]);
  });

  it("마커 없는 섹션은 DOM 을 건드리지 않는다", () => {
    const html = `<p dir="auto">그냥 글 <strong>굵게</strong></p>`;
    const el = section(html);
    decorateRendered(el, ["그냥 글 **굵게**"], OPTIONS);
    expect(el.innerHTML).toBe(html);
  });
});
