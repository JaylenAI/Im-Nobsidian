/**
 * P11 — lookbehind 를 쓰던 정규식(예전 소스 그대로)과 바꾼 {@link LookbehindRegExp} 가 같은 결과를 내는지. 무작위 글로
 * `replace` · `matchAll` · `split` · `test` 를 견준다. 이 파일은 플러그인에 실리지 않아 lookbehind 를 써도 된다.
 */
import { describe, it, expect } from "vitest";
import {
  LookbehindRegExp,
  charBefore,
  evenBackslashesBefore,
  notAfter,
  notAfterText,
} from "../../src/utils/lookbehind.js";
import { MARKER_BRAND_RE, MARKER_PAYLOAD_CHAR } from "../../src/constants/markers.js";

const U = String.raw`(?:[^*_\n\\]|\\[^\n])`;
const L = String.raw`(?:[^*_\n\\\s]|\\[^\n\s\\])`;
const MEDIA = `%%\\s*${MARKER_BRAND_RE}:local-(?:image|file):${MARKER_PAYLOAD_CHAR}+?\\s*%%`;

/** 예전 정규식 · 바꾼 정규식 · 무작위 글의 재료. */
const PAIRS: { name: string; old: RegExp; now: RegExp; alphabet: string[] }[] = [
  {
    name: "위키링크(임베드 아님)",
    old: /(?<!!)\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g,
    now: new LookbehindRegExp(/\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g, undefined, notAfter(/!/)),
    alphabet: ["!", "[[", "]]", "|", "a", "가", " ", "[", "]"],
  },
  {
    name: "제목 링크",
    old: /(?<!!)\[\[([^[\]|]*#[^[\]|]*?)\\?(?:\|[^[\]]+)?\]\]/g,
    now: new LookbehindRegExp(
      /\[\[([^[\]|]*#[^[\]|]*?)\\?(?:\|[^[\]]+)?\]\]/g,
      undefined,
      notAfter(/!/),
    ),
    alphabet: ["!", "[[", "]]", "|", "#", "\\", "a", " "],
  },
  {
    name: "글로 남는 위키링크",
    old: /(?<!!)\[\[(?!notion:)([^[\]\n]+)\]\]/g,
    now: new LookbehindRegExp(/\[\[(?!notion:)([^[\]\n]+)\]\]/g, undefined, notAfter(/!/)),
    alphabet: ["!", "[[", "]]", "notion:", "a", "\n", " "],
  },
  {
    name: "위키링크 서식 글자",
    old: /(?<!\\)([*_~`$])/g,
    now: new LookbehindRegExp(/([*_~`$])/g, undefined, notAfter(/\\/)),
    alphabet: ["\\", "*", "_", "~", "`", "$", "a"],
  },
  {
    name: "각주",
    old: /(?<!\\)\[\^([^\]\s]+)\]/g,
    now: new LookbehindRegExp(/\[\^([^\]\s]+)\]/g, undefined, notAfter(/\\/)),
    alphabet: ["\\", "[^", "]", "1", "a", " "],
  },
  {
    name: "하이라이트",
    old: /(?<!=)==([^=\n]+?)==(?!=)/g,
    now: new LookbehindRegExp(/==([^=\n]+?)==(?!=)/g, undefined, notAfter(/=/)),
    alphabet: ["=", "==", "a", "\n", " "],
  },
  {
    name: "$$",
    old: /(?<![\\$])\$\$(?!\$)/g,
    now: new LookbehindRegExp(/\$\$(?!\$)/g, undefined, notAfter(/[\\$]/)),
    alphabet: ["\\", "$", "$$", "a"],
  },
  {
    name: "자식 페이지 제목의 _",
    old: /(?<!\\)_/g,
    now: new LookbehindRegExp(/_/g, undefined, notAfter(/\\/)),
    alphabet: ["\\", "_", "a"],
  },
  {
    name: "NFM 칸 파이프",
    old: /(?<!\\)\|/,
    now: new LookbehindRegExp(/\|/, undefined, notAfter(/\\/)),
    alphabet: ["\\", "|", "a", " "],
  },
  {
    name: "NFM 끝 파이프",
    old: /(?<!\\)\|$/,
    now: new LookbehindRegExp(/\|$/, undefined, notAfter(/\\/)),
    alphabet: ["\\", "|", "a"],
  },
  {
    name: "표 경계 파이프",
    old: /(?<=(?:^|[^\\])(?:\\\\)*)\|/g,
    now: new LookbehindRegExp(/\|/g, undefined, evenBackslashesBefore),
    alphabet: ["\\", "|", "a", " "],
  },
  {
    name: "표 경계 파이프(하나)",
    old: /(?<=(?:^|[^\\])(?:\\\\)*)\|/,
    now: new LookbehindRegExp(/\|/, undefined, evenBackslashesBefore),
    alphabet: ["\\", "|", "a"],
  },
  {
    name: "표 끝 파이프",
    old: /(?<=(?:^|[^\\])(?:\\\\)*)\|$/,
    now: new LookbehindRegExp(/\|$/, undefined, evenBackslashesBefore),
    alphabet: ["\\", "|", "a"],
  },
  {
    name: "수식의 prop",
    old: /(?<!current\.)prop\("([^"]+)"\)/g,
    now: new LookbehindRegExp(/prop\("([^"]+)"\)/g, undefined, notAfterText("current.")),
    alphabet: ["current.", "prop(", '"', ")", "a", "."],
  },
  {
    name: "글 * 가 든 기울임",
    old: /(?<![\\*\p{L}\p{N}])\*(?![\s*])((?:[^*_\n\\]|\\[^\n])*?\\\*(?:[^*_\n\\]|\\[^\n])*?)(?<![\s\\])\*(?![*\p{L}\p{N}])/gu,
    now: new LookbehindRegExp(
      new RegExp(String.raw`\*(?![\s*])(${U}*?\\\*(?:${U}*?${L})??)\*(?![*\p{L}\p{N}])`, "gu"),
      undefined,
      notAfter(/[\\*\p{L}\p{N}]/u),
    ),
    alphabet: ["*", "\\", "\\*", "_", " ", "a", "가", "1", "\n", "𝐀", "."],
  },
  {
    name: "📎 뒤가 아닌 미디어 마커",
    old: new RegExp(`(?<!📎[^\\n]*)${MEDIA}`, "gu"),
    now: new LookbehindRegExp(
      MEDIA,
      "gu",
      (text, index) => !text.slice(text.lastIndexOf("\n", index - 1) + 1, index).includes("📎"),
    ),
    alphabet: [
      "📎",
      "\n",
      " ",
      "a",
      `%% ${"im-nobsidian"}:local-image:x.png %%`,
      "%%im-nobsidian:local-file:y%%",
    ],
  },
  {
    name: "기울임 구분자 _ (플러그인 visible-text — 마지막 갈래의 lookbehind)",
    old: /(^|[\s\p{P}])_+(?=\S)|(?<=\S)_+(?=[\s\p{P}]|$)/gu,
    now: new LookbehindRegExp(
      /(^|[\s\p{P}])_+(?=\S)|_+(?=[\s\p{P}]|$)/gu,
      undefined,
      (text, index, match) => match[1] !== undefined || /\S/u.test(charBefore(text, index)),
    ),
    alphabet: ["_", "__", " ", "a", "가", ".", "\n", "𝐀"],
  },
  {
    name: "같은 길이의 백틱",
    old: /(?<!`)``(?!`)/g,
    now: new LookbehindRegExp(/``(?!`)/g, undefined, notAfter(/`/)),
    alphabet: ["`", "``", "a"],
  },
];

/** 같은 씨앗이면 같은 글 — 실패를 다시 볼 수 있게. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function sample(alphabet: string[], next: () => number): string {
  const length = Math.floor(next() * 14);
  let text = "";
  for (let i = 0; i < length; i++) text += alphabet[Math.floor(next() * alphabet.length)]!;
  return text;
}

const outcomes = (re: RegExp, text: string) => ({
  replaced: text.replace(re, (...args) => `<${String(args[0])}|${String(args.at(-2))}>`),
  matches: re.global ? [...text.matchAll(re)].map((m) => [m.index, ...m]) : null,
  split: text.split(re),
  test: re.test(text),
  exec: re.global ? null : re.exec(text)?.index,
});

describe("LookbehindRegExp — 예전 lookbehind 와 같은 결과", () => {
  for (const { name, old, now, alphabet } of PAIRS) {
    it(name, () => {
      const next = random(name.length * 7919);
      for (let i = 0; i < 3000; i++) {
        const text = sample(alphabet, next);
        old.lastIndex = 0;
        now.lastIndex = 0;
        const expected = outcomes(old, text);
        old.lastIndex = 0;
        now.lastIndex = 0;
        expect(outcomes(now, text), JSON.stringify(text)).toEqual(expected);
      }
    });
  }

  it("lastIndex 를 옮겨 exec 해도 같다", () => {
    const old = /(?<!`)``(?!`)/g;
    const now = new LookbehindRegExp(/``(?!`)/g, undefined, notAfter(/`/));
    const text = "a```b``c````d``";
    for (let start = 0; start <= text.length + 1; start++) {
      old.lastIndex = start;
      now.lastIndex = start;
      expect(now.exec(text)?.index).toBe(old.exec(text)?.index);
      expect(now.lastIndex).toBe(old.lastIndex);
    }
  });

  it("조건이 없으면 만들지 않는다", () => {
    expect(() => new LookbehindRegExp(/a/)).toThrow(TypeError);
  });

  it("charBefore 는 써로게이트 쌍을 한 글자로", () => {
    expect(charBefore("a𝐀b", 3)).toBe("𝐀");
    expect(charBefore("ab", 0)).toBe("");
  });
});
