/**
 * lookbehind 없이 앞 글을 보는 정규식 — 소스에 `(?<!…)` · `(?<=…)` 를 쓰지 않는다.
 *
 * iOS 16.4 앞의 JavaScript 는 lookbehind 를 읽지 못해, 그런 정규식 하나가 든 스크립트 전체가 뜨지 않는다 — 플러그인이
 * 모바일에서 아예 켜지지 않는다(P11). 커뮤니티 디렉터리의 검사도 데스크톱 전용이 아닌 플러그인의 lookbehind 를
 * 거절한다. `tests/utils/no-lookbehind.test.ts` 가 소스에 다시 들어오지 않게 막는다.
 *
 * `exec` 만 갈아 끼운다 — `replace` · `matchAll` · `split` · `test` 가 모두 `exec` 를 부르므로 쓰는 곳은 바뀌지 않는다.
 * 맞은 자리의 앞 글이 조건에 맞지 않으면 그 자리를 버리고 다음 글자에서 다시 찾는다. 정규식 맨 앞(또는 마지막
 * 갈래의 맨 앞)의 lookbehind 와 결과가 같다 — 엔진도 그 자리에서 lookbehind 가 막히면 다음 글자로 넘어간다.
 */

/** 맞은 것을 받나 — `index` 는 맞은 자리, `match` 는 맞은 것(갈래를 가를 때). */
export type Lookbehind = (text: string, index: number, match: RegExpExecArray) => boolean;

export class LookbehindRegExp extends RegExp {
  readonly accept: Lookbehind;
  /** 실제로 찾는 정규식 — `g`(또는 `y`) 로 어느 자리에서든 이어 찾는다. */
  private readonly scanner: RegExp;

  constructor(pattern: string | RegExp, flags?: string, accept?: Lookbehind) {
    super(pattern, flags);
    // `split` · `matchAll` 은 `new this.constructor(this, flags)` 로 사본을 만든다 — 조건을 이어받는다
    const inherited = pattern instanceof LookbehindRegExp ? pattern.accept : undefined;
    const resolved = accept ?? inherited;
    if (!resolved) throw new TypeError("LookbehindRegExp 에 앞 글 조건이 없음");
    this.accept = resolved;
    this.scanner = new RegExp(
      this.source,
      this.sticky || this.global ? this.flags : `${this.flags}g`,
    );
  }

  override exec(text: string): RegExpExecArray | null {
    const keepsIndex = this.global || this.sticky;
    const start = keepsIndex ? this.lastIndex : 0;
    this.scanner.lastIndex = start;
    for (;;) {
      const match = start > text.length ? null : this.scanner.exec(text);
      if (match === null) {
        if (keepsIndex) this.lastIndex = 0;
        return null;
      }
      if (this.accept(text, match.index, match)) {
        if (keepsIndex) this.lastIndex = this.scanner.lastIndex;
        return match;
      }
      // `y` 는 그 자리만 본다 — 다음 자리는 부른 쪽(`split`)이 옮겨 가며 묻는다
      if (this.sticky) {
        this.lastIndex = 0;
        return null;
      }
      this.scanner.lastIndex = match.index + codeUnitsAt(text, match.index, this.unicode);
    }
  }
}

/** `index` 의 글자 하나가 차지하는 코드 단위 — `u` 정규식은 써로게이트 쌍 가운데서 찾지 않는다. */
function codeUnitsAt(text: string, index: number, unicode: boolean): number {
  return unicode && (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
}

/** `index` 바로 앞의 글자(써로게이트 쌍은 하나로) — 맨 앞이면 "". */
export function charBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const low = text.charCodeAt(index - 1);
  const isLow = low >= 0xdc00 && low <= 0xdfff;
  const high = index >= 2 ? text.charCodeAt(index - 2) : 0;
  return isLow && high >= 0xd800 && high <= 0xdbff
    ? text.slice(index - 2, index)
    : text.slice(index - 1, index);
}

/** `(?<![…])` — 바로 앞 글자가 `set`(글자 하나를 보는 정규식)에 맞지 않거나 맨 앞이다. */
export function notAfter(set: RegExp): Lookbehind {
  return (text, index) => {
    const before = charBefore(text, index);
    return before === "" || !set.test(before);
  };
}

/** `(?<!글)` — 바로 앞이 그 글로 끝나지 않는다. */
export function notAfterText(literal: string): Lookbehind {
  return (text, index) => !text.slice(Math.max(0, index - literal.length), index).endsWith(literal);
}

/** `(?<=(?:^|[^\\])(?:\\\\)*)` — 바로 앞의 백슬래시가 짝수 개(0 포함)다. 그 뒤 글자는 이스케이프되지 않았다. */
export function evenBackslashesBefore(text: string, index: number): boolean {
  let count = 0;
  while (index - count - 1 >= 0 && text[index - count - 1] === "\\") count++;
  return count % 2 === 0;
}
