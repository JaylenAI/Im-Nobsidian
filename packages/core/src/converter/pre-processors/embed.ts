import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import type { ImageReference } from "../../types/convert.js";
import {
  MARKER_BRAND_RE,
  MARKER_PAYLOAD_CHAR,
  MARKER_TOKEN_RE,
  spacedMarker,
} from "../../constants/markers.js";
import { mapOutsideCode, mapOutsideCodeFences } from "../../utils/md-regions.js";
import { encodeMarkerTarget } from "../marker-url.js";
import { pushContainerKind } from "../container-head.js";

/**
 * 대상에 `[` `]` 를 허용하지 않는다 — 이유는 WikilinkResolver 쪽 주석 참조.
 * 앞뒤 가로 공백까지 함께 잡는다 — 자리표시자를 줄 단독으로 떼어낼 때 이 공백이
 * 새 줄머리로 옮겨가면 안 되기 때문이다({@link isolate} 주석 참조).
 * 임베드가 인용/콜아웃 줄을 통째로 차지하고 있으면 그 `>` 접두사까지 함께 잡는다 —
 * 자리표시자만 떼어내고 접두사를 남기면 빈 껍데기 줄이 된다({@link isolate} 주석 참조).
 */
const OBSIDIAN_EMBED_REGEX = /((?:^[ \t]*(?:>[ \t]*)+)?[ \t]*)!\[\[([^[\]]+)\]\]([ \t]*)/gm;

/** {@link OBSIDIAN_EMBED_REGEX} 의 lead 가 인용 접두사를 삼켰는지 — 즉 줄머리인지. */
const QUOTE_LEAD = /^[ \t]*>/;
/** 줄머리의 인용 접두 — 들여쓰기 · `>` · 그 사이 공백. */
const QUOTE_PREFIX_RE = /^[ \t]*(?:>[ \t]*)+/;
/** 줄머리 들여쓰기. */
const LEADING_SPACE_RE = /^[ \t]*/;
/** 콜아웃 · 토글 머리 줄의 세 토막 — 인용 접두 · `[!종류]`(접기 표시 포함) · 제목. */
const HEAD_LINE_PARTS_RE = /^([ \t]*(?:>[ \t]*)+)(\[![^\]\s]+\][-+]?)(.*)$/;
/** 제목 속 임베드 — 앞 가로 공백까지. */
const TITLE_EMBED_RE = /[ \t]*!\[\[([^[\]]+)\]\]/g;
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

const VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com"];

/**
 * 노트에 홀로 남은 미디어 마커 — 같은 줄 앞에 `📎` 가 없는 것. push 가 심는 자리표시자
 * (`> 📎 이름 %% …:local-image:… %%`)와 가른다.
 */
const STRAY_MEDIA_MARKER_RE = new RegExp(
  `(?<!📎[^\\n]*)%%\\s*${MARKER_BRAND_RE}:local-(?:image|file):${MARKER_PAYLOAD_CHAR}+?\\s*%%`,
  "gu",
);

export class EmbedResolver implements Processor {
  readonly name = "EmbedResolver";
  readonly order = 60;

  process(input: ProcessorInput): ProcessorOutput {
    const images: ImageReference[] = input.metadata.images ? [...input.metadata.images] : [];
    const isPush = input.context.direction === "push";

    const source = isPush ? lowerHeadEmbeds(dropStrayMediaMarkers(input.content)) : input.content;
    // 코드 펜스 · 인라인 코드 안은 건너뛴다(S-18) — 임베드 문법을 보여 주는 글이고, Obsidian 도
    // 임베드로 그리지 않는다. 예전에는 여기서도 자리표시자로 바꿨다. 펜스 안이면 Notion 의 코드에
    // `> 📎 …` 가 보였고, 인라인 코드는 둘로 쪼개져 그 사이에 자리표시자 줄이 들어갔다 — 다시
    // 받으면 노트의 그 줄이 쪼개진 채로 돌아왔다.
    const content = mapOutsideCode(source, (segment, base) =>
      this.resolveMarkdownImages(this.resolveEmbeds(segment, base, source, isPush, images), images),
    );

    return {
      content,
      metadata: { ...input.metadata, images },
    };
  }

  /** `![[대상]]` — 첨부는 자리표시자로(push), 노트 임베드는 원문 그대로. */
  private resolveEmbeds(
    segment: string,
    base: number,
    source: string,
    isPush: boolean,
    images: ImageReference[],
  ): string {
    return segment.replace(
      OBSIDIAN_EMBED_REGEX,
      (match: string, lead: string, target: string, trail: string, offset: number) => {
        // 자리표시자를 자기 줄로 떼어 낼지는 줄 전체를 보고 정한다 — 조각이 아니라 원문 기준이다.
        // 인라인 코드 뒤의 임베드는 조각의 맨 앞이지만 줄의 맨 앞이 아니다.
        const span = { offset: base + offset, length: match.length, whole: source, lead, trail };
        if (isImageFile(target)) {
          images.push({ url: target, localPath: stripAlias(target), isExternal: false });
          if (isPush && isLocalMedia(target)) {
            return isolate(placeholder("local-image", target), span);
          }
          return `${lead}![${target}](${encodeURI(target)})${trail}`;
        }
        // 비이미지 로컬 첨부 파일(pdf/mov 등): EMBED_PROTOCOL href 는 Notion 이 스킴을
        // 버려 평문으로 강등된다 — 이미지와 동일한 quote+마커 쌍으로 왕복을 보존한다(D5).
        if (isPush && isLocalMedia(target)) {
          return isolate(placeholder("local-file", target), span);
        }
        /*
         * 노트 임베드(확장자 없음·.md·.canvas)와 외부 URL 임베드는 **원문 그대로** 올린다.
         *
         * 예전엔 여기서도 `[대상](im-nobsidian://embed/…)` 로 바꿔 올렸다. 그런데 Notion 은
         * 미지원 스킴을 링크째 버리고 **라벨 텍스트만** 남긴다 — 첨부 파일에 대해 위(D5)에서
         * 이미 실측한 그 현상이 노트 임베드에도 똑같이 일어난다. `![[대상|별칭]]` 이 평문
         * `대상|별칭` 으로 영구 붕괴하고, pull 의 복원기는 되살릴 href 자체를 못 본다.
         * (실볼트에는 `…했어요![[neutral]]` 처럼 느낌표 뒤 위키링크가 526곳 있어 편집 후
         *  push 하면 그만큼 대괄호가 통째로 날아갔다.)
         *
         * 반면 `![[대상]]` 을 손대지 않고 그대로 올리면 Notion 은 일반 텍스트로 저장하고
         * pull 이 글자 그대로 되돌린다 — 별칭 포함 무손실 왕복(실측). Notion 에는 전치
         * (transclusion) 개념이 없으므로 Obsidian 문법을 원문 보존하는 편이 정직하고 안전하다.
         */
        return match;
      },
    );
  }

  /** `![설명](url)` — 동영상 URL 은 임베드 마커로, 외부 이미지는 목록에 모은다. */
  private resolveMarkdownImages(segment: string, images: ImageReference[]): string {
    return segment.replace(MARKDOWN_IMAGE_REGEX, (_match, alt: string, url: string) => {
      if (isVideoUrl(url)) {
        return `${spacedMarker(`embed:type=video&url=${encodeURIComponent(url)}`)}\n[${alt || "Video"}](${url})`;
      }
      if (isExternalUrl(url)) {
        images.push({ url, isExternal: true });
      }
      return `![${alt}](${url})`;
    });
  }
}

/**
 * 노트에 홀로 남은 미디어 마커를 뗀다(S-19).
 *
 * push 는 임베드만 자리표시자로 바꾸므로 노트에 마커가 따로 있을 까닭이 없다. 있다면 v0.3.2 의
 * pull 이 남긴 것이다 — Notion 에서 캡션을 고치거나 미디어를 지우면 보존 마커 주입기가 push 때의
 * 마커를 되살렸다. 그대로 올리면 자리표시자로 읽혀 옛 파일을 한 번 더 올리고, 지운 미디어가
 * 되살아난다. 사용자가 쓴 것이 아니고, 읽기 화면에서는 주석이라 보이지도 않는다.
 *
 * 보내는 본문에서만 뗀다 — push 는 볼트에 쓰지 않는다. 마커만 있던 줄은 빈 줄이 된다. 코드 안의
 * 마커(마커 형식을 설명하는 글)는 건드리지 않는다.
 */
function dropStrayMediaMarkers(content: string): string {
  return mapOutsideCode(content, (segment) => segment.replace(STRAY_MEDIA_MARKER_RE, ""));
}

/**
 * 콜아웃 · 토글 머리 줄의 첨부 임베드를 바로 아랫줄, 그 컨테이너의 첫 줄로 내린다(S-28).
 *
 * Notion 콜아웃 · 토글의 제목(rich text)에는 이미지 · 첨부 · DB 가 들어가지 못하고 자식으로만 들어간다.
 * 제목이 비고 첫 자식이 DB 인 콜아웃을 받으면 그 DB 가 머리 줄에 놓인다(`> [!note] ![[표.base|표]]`,
 * 실볼트 52줄). 임베드를 그 자리에서 떼면 머리 줄의 나머지 — 콜아웃 색 · 아이콘 마커 — 가 본문 줄로
 * 밀려 Notion 에 글자로 실리고 색을 잃었다. 제목에서 임베드만 빼 첫 자식 줄로 내리면 받은 모양 그대로
 * 간다.
 *
 * push 가 컨테이너 머리로 바꾸는 줄만 본다({@link calloutHome}). 인라인 코드가 든 머리 줄은 그대로
 * 둔다 — 코드 속 임베드 문법은 글자다.
 */
function lowerHeadEmbeds(content: string): string {
  return mapOutsideCodeFences(content, (segment, base) => {
    let start = base;
    return segment
      .split("\n")
      .map((line) => {
        const isHead = line.includes("![[") && calloutHome(content, start)?.head === start;
        start += line.length + 1;
        return isHead ? lowerHeadEmbed(line) : line;
      })
      .join("\n");
  });
}

/** 머리 줄 하나 — 제목에서 첨부 임베드를 빼고 한 줄씩 아래에 둔다. 없으면 그대로. */
function lowerHeadEmbed(line: string): string {
  const head = HEAD_LINE_PARTS_RE.exec(line);
  if (!head || line.includes("`")) return line;
  const [, prefix = "", kind = "", title = ""] = head;
  const lowered: string[] = [];
  const rest = title.replace(TITLE_EMBED_RE, (embed: string, target: string) => {
    if (!isLocalMedia(target)) return embed;
    lowered.push(embed.trim());
    return "";
  });
  if (lowered.length === 0) return line;
  const body = `${prefix.trimEnd()} `;
  return [`${prefix}${kind}${rest}`.trimEnd(), ...lowered.map((embed) => body + embed)].join("\n");
}

/** push 가 자리표시자로 올리는 임베드인가 — 볼트의 이미지 · 첨부. */
function isLocalMedia(target: string): boolean {
  return !isExternalUrl(target) && (isImageFile(target) || isAttachmentFile(target));
}

/** `경로|300` 형태의 표시 별칭을 떼고 실제 볼트 경로만 남긴다. */
function stripAlias(target: string): string {
  return target.split("|")[0]!;
}

/**
 * push 가 심는 미디어 자리표시자. 업로드가 성공하면 ImageHandler 가 이 quote 를 실제
 * image/file 블록으로 **제자리 교체**하므로 반드시 **한 줄**이어야 한다 — 두 줄로 쓰면
 * Notion Markdown API 가 quote 를 두 블록으로 쪼개, 마커 줄만 지워지고 `📎 파일명` 줄이
 * 미디어 옆에 유령처럼 남는다(실측). 업로드가 실패했을 때 사용자가 무엇이 빠졌는지
 * 알아볼 수 있도록 파일명은 남겨 둔다.
 *
 * 경로는 위키링크 마커(53행)와 같이 퍼센트 인코딩해 싣는다. 원문 그대로 실으면
 * 캡션의 `50%` 같은 홑 `%` 가 마커 종결자 탐색을 깨뜨려 복원기가 자리표시자를
 * 통째로 못 알아보고, pull 결과에 임베드 대신 마커 원문이 노출됐다
 * (실볼트 `LLM Inference` 한 파일에서만 임베드 13개 중 3개 소실).
 */
function placeholder(kind: "local-image" | "local-file", target: string): string {
  const fileName = stripAlias(target).split("/").pop() ?? target;
  return `> 📎 ${fileName} ${spacedMarker(`${kind}:${encodeMarkerTarget(target)}`)}`;
}

/** 임베드가 원문에서 차지한 자리 — 앞뒤 가로 공백까지 포함한다. */
interface EmbedSpan {
  offset: number;
  length: number;
  whole: string;
  lead: string;
  trail: string;
}

/**
 * 자리표시자를 **자기 줄 단독**으로 떼어 놓는다.
 *
 * 자리표시자는 quote 블록이라 줄머리에 있어야만 Notion 이 블록으로 인식하고, 그래야
 * ImageHandler 가 업로드 성공 뒤 그 블록을 image/file 블록으로 제자리 교체한다.
 * `느낌표 뒤![[neutral.png]] 주의.` 처럼 글자 바로 뒤에 붙은 임베드(실볼트 806건/26파일)는
 * 그대로 두면 `느낌표 뒤> 📎 …` 라는 한 문단이 되어 quote 가 아니게 되고 — 교체 대상이
 * 사라져 이미지가 끝내 안 올라간다(실측).
 *
 * Notion 에는 인라인 이미지가 없으므로 문단이 갈리는 것은 데이터 모델상 불가피하다.
 * 앞뒤 글자는 한 자도 버리지 않고, 한 번 갈린 뒤로는 모양이 고정된다(멱등).
 *
 * 끊는 방식이 두 가지 이유로 까다롭다(둘 다 실 Notion 실측):
 *  1. 줄바꿈 한 개로는 모자란다 — CommonMark lazy continuation 이 뒷글자를 quote 안으로
 *     빨아들이고, quote 를 image 로 통째 교체할 때 그 글자가 같이 지워졌다. 2026-10-04 재실측
 *     (생성 · 본문 교체 두 경로)에서는 같은 깊이의 뒷글이 이어 붙지 않았다 — 빈 줄은 문단 사이에
 *     남지 않으므로 끊기는 그대로 둔다.
 *  2. 빈 줄로 끊어도, **뒷줄이 공백으로 시작하면 Notion 파서가 그 문단을 앞 quote 의
 *     자식으로 중첩시킨다**. `deleteBlock(quote)` 가 자식째 날려 `주의.` 가 또 사라졌다.
 *     그래서 임베드에 붙어 있던 가로 공백은 새 줄머리로 옮기지 않고 버린다 — 문단이
 *     이미 갈린 마당에 줄머리 공백은 의미가 없다.
 *
 * 줄 전체가 공백뿐이면(목록 안 들여쓰기 등) 원래 들여쓰기를 그대로 돌려준다.
 *
 * 콜아웃 · 토글 안의 임베드는 그 컨테이너 안에 둔다({@link isolateInCallout}, S-28). 머리 줄의
 * 임베드는 미리 첫 자식 줄로 내려 와 있다({@link lowerHeadEmbeds}).
 *
 * 일반 인용 줄을 임베드가 통째로 차지한 경우(`> ![[x.png]]`)에는 `>` 접두사를 **되돌려 쓰지
 * 않는다**. Notion 의 인용 블록은 글 사이에 이미지를 품지 못해 자리표시자가 자기 블록으로 떨어져
 * 나가야 하고, 접두사만 남기면 `>` 하나뿐인 껍데기 줄이 인용 안에 눌러앉는다. 그 껍데기는 왕복
 * 1회차엔 남고 2회차엔 사라져 파일이 영영 수렴하지 않았다(실볼트 34파일 실측).
 */
function isolate(text: string, span: EmbedSpan): string {
  const { offset, length, whole } = span;
  const lineStart = whole.lastIndexOf("\n", offset - 1) + 1;
  const beforeOnLine = whole.slice(lineStart, offset);
  const afterIdx = offset + length;
  const nl = whole.indexOf("\n", afterIdx);
  const afterOnLine = whole.slice(afterIdx, nl === -1 ? whole.length : nl);
  const atLineHead = QUOTE_LEAD.test(span.lead);

  // 임베드가 놓인 인용 줄의 접두 — 줄머리 임베드면 lead 가 삼켰고, 글 뒤의 임베드면 줄 앞부분에 있다.
  const prefix = QUOTE_PREFIX_RE.exec(atLineHead ? span.lead : beforeOnLine)?.[0] ?? "";
  const home = calloutHome(whole, lineStart);
  if (home) {
    const prevStart = lineStart === 0 ? -1 : whole.lastIndexOf("\n", lineStart - 2) + 1;
    return isolateInCallout(text, {
      prefix,
      home,
      textBefore: !atLineHead,
      textAfter: afterOnLine.trim() !== "",
      // 바로 윗줄이 컨테이너의 머리 줄이면 자리표시자가 첫 자식이다 — 끊을 글이 없다.
      prev: prevStart < 0 || prevStart === home.head ? null : lineAt(whole, prevStart),
      next: nl === -1 ? null : lineAt(whole, nl + 1),
    });
  }

  const tail = afterOnLine.trim() === "" ? "" : "\n\n";
  // 인용 접두사를 삼킨 경우 lead 는 줄머리에서 시작하므로 앞에 빈 줄 하나면 충분하다.
  if (atLineHead) return `${offset === 0 ? "" : "\n"}${text}${tail}`;

  const head = beforeOnLine.trim() === "" ? span.lead : "\n\n";
  return `${head}${text}${tail}`;
}

/** 임베드를 품은 가장 안쪽 콜아웃 · 토글. */
interface CalloutHome {
  /** 인용 깊이 — 1 이상, 임베드 줄의 깊이 이하. */
  depth: number;
  /** `[!toggle]` 이면 Notion 의 토글(`<details>`)로 간다. */
  toggle: boolean;
  /** 머리 줄의 시작 위치. */
  head: number;
  /** 임베드 줄이 이 컨테이너 본문 안에서 들여써진 만큼 — 목록 항목에 딸린 줄 등. 머리 줄이면 빈 글. */
  indent: string;
}

/** 콜아웃 · 토글 안 임베드의 자리 — {@link isolateInCallout} 가 쓴다. */
interface CalloutSpot {
  /** 임베드 줄의 인용 접두. */
  prefix: string;
  home: CalloutHome;
  /** 같은 줄에서 임베드 앞에 글이 있는가. */
  textBefore: boolean;
  /** 같은 줄에서 임베드 뒤에 글이 이어지는가. */
  textAfter: boolean;
  /** 컨테이너 안의 윗줄 — 머리 줄이거나 글 맨 앞이면 null. */
  prev: string | null;
  /** 아랫줄 — 글 끝이면 null. */
  next: string | null;
}

/**
 * 콜아웃 · 토글 안의 임베드 — 자리표시자를 그 컨테이너의 **자식 인용**으로 둔다(S-28).
 *
 * 예전에는 일반 인용처럼 접두를 떼고 빈 줄로 끊어 컨테이너 밖으로 내보냈다. Notion 에 첨부를 콜아웃
 * 안에 넣을 수단이 없다고 봤기 때문인데, 실제로는 콜아웃 · 토글의 자식 인용을 이미지로 제자리 교체하면
 * 이미지가 그 안에 들어간다. 컨테이너를 끊은 탓에 뒷줄이 일반 인용이 되고, 이미지뿐인 토글은 비고,
 * 토글 속 칼럼은 마커가 짝을 잃어 사라졌다(실볼트 컨테이너 속 임베드 203줄 · 30노트).
 *
 * 실측(2026-10-04): 콜아웃 안 `> > 📎 …` 는 빈 줄 없이도 앞뒤 줄과 갈려 콜아웃의 자식 문단 · 인용 ·
 * 문단이 되고, 토글 · 토글 속 칼럼 · 겹친 콜아웃 안에서도 그 자리의 자식이 됐다 — 교체한 이미지가 모두
 * 제자리에 들어갔다.
 *
 * 자리표시자는 그 줄이 컨테이너 본문 안에서 들여써진 만큼(목록 항목에 딸린 줄 등) 들여쓴다. 자리표시자보다
 * 깊이 들여쓴 뒷줄은 빈 줄을 사이에 두어도 Notion 이 자리표시자 인용의 자식으로 묶어, 이미지로 교체할 때
 * 함께 지워진다(실측 2026-10-04 — 생성 · 본문 교체 두 경로 같음). 들여쓰기를 지키면 뒷줄과 형제가 된다.
 *
 * 앞뒤 글이 자리표시자 인용에 붙을 자리만 그 컨테이너 깊이의 빈 줄로 끊는다. 토글 본문은 맨 바깥처럼
 * 들여쓰기 없이 실려, 옛 실측에서 뒷글이 자리표시자에 이어 붙던 모양이다({@link isolate} 주석). 콜아웃
 * 본문은 탭으로 들여써 실려 줄바꿈 하나로 갈린다(실측). 컨테이너 안의 일반 인용 속 임베드는 그 인용
 * 밖, 컨테이너 안으로 떨어진다 — 맨 바깥 일반 인용과 같은 까닭이다 — 그래서 그 인용과 맞닿는 쪽도
 * 끊는다. Notion 은 컨테이너 안의 빈 줄을 버려(실측) 끊은 줄은 Notion 에 남지 않는다.
 */
function isolateInCallout(text: string, spot: CalloutSpot): string {
  const { home } = spot;
  const own = `${prefixTo(spot.prefix, home.depth)}${home.indent}`;
  const blank = own.trimEnd();
  const depth = quoteDepthOf(spot.prefix);
  const sticks = (lineDepth: number, hasText: boolean): boolean =>
    lineDepth > home.depth || (home.toggle && lineDepth === home.depth && hasText);
  const sticksLine = (line: string | null): boolean =>
    line !== null && sticks(quoteDepthOf(line), hasText(line));

  const cutBefore = spot.textBefore ? sticks(depth, true) : sticksLine(spot.prev);
  const cutAfter = spot.textAfter ? sticks(depth, true) : sticksLine(spot.next);
  const before = `${spot.textBefore ? "\n" : ""}${cutBefore ? `${blank}\n` : ""}`;
  const rest = depth > home.depth ? prefixTo(spot.prefix, depth) : own;
  const after = `${cutAfter ? `\n${blank}` : ""}${spot.textAfter ? `\n${rest}` : ""}`;
  return `${before}${own}${text}${after}`;
}

/** 인용 접두 · 마커를 뺀 글이 있는가 — 칼럼 마커뿐인 줄은 Notion 에 글로 가지 않는다. */
function hasText(line: string): boolean {
  return line.replace(QUOTE_PREFIX_RE, "").replace(MARKER_TOKEN_RE, "").trim() !== "";
}

/**
 * 이 줄을 품은 가장 안쪽 콜아웃 · 토글 — 없으면 null(인용 밖이거나 일반 인용뿐). 줄이 머리 줄이면
 * 그 컨테이너다.
 *
 * push 변환기가 컨테이너를 찾는 길을 그대로 밟는다 — 맨 바깥 블록의 머리부터 인용 한 겹씩 벗기며 안쪽
 * 블록의 머리를 {@link pushContainerKind} 로 가린다. 변환기가 컨테이너로 보지 않는 블록(일반 인용,
 * `>[!note]` 처럼 꼴이 다른 머리)을 만나면 거기서 멈춘다 — 그 아래 콜아웃도 변환기는 글자로 보낸다.
 *
 * 머리부터 이 줄까지의 본문 줄은 `> ` 꼴만 받는다(빈 줄은 `>`). 변환기도 콜아웃 본문을 그 꼴에서
 * 끊는다. 토글 본문은 변환기가 더 너그럽게 받지만, 좁게 보면 자리표시자를 예전처럼 밖으로 낼 뿐이다.
 */
function calloutHome(whole: string, lineStart: number): CalloutHome | null {
  if (quoteDepthOf(lineAt(whole, lineStart)) === 0) return null;
  // 맨 바깥 인용 블록의 머리부터 이 줄까지 — 줄 시작 위치와 줄.
  const starts = [lineStart];
  while (starts[0]! > 0) {
    const above = whole.lastIndexOf("\n", starts[0]! - 2) + 1;
    if (quoteDepthOf(lineAt(whole, above)) === 0) break;
    starts.unshift(above);
  }
  let lines = starts.map((start) => lineAt(whole, start));
  let first = 0;
  let home: CalloutHome | null = null;
  for (let depth = 1; ; depth++) {
    const kind = pushContainerKind(lines[0]!);
    if (kind === null) return home;
    const quote = `${LEADING_SPACE_RE.exec(lines[0]!)![0]}>`;
    const body = lines.slice(1).map((line) => stripQuote(line, quote));
    if (body.includes(null)) return home;
    const indent = LEADING_SPACE_RE.exec(body.at(-1) ?? "")![0];
    home = { depth, toggle: kind === "toggle", head: starts[first]!, indent };

    // 안쪽 블록 — 이 줄에서 위로 인용 줄이 이어지는 데까지. 이 줄이 인용 밖이면 이 컨테이너의 직속 줄이다.
    let top = body.length - 1;
    if (top < 0 || quoteDepthOf(body[top]!) === 0) return home;
    while (top > 0 && quoteDepthOf(body[top - 1]!) > 0) top--;
    lines = body.slice(top) as string[];
    first += 1 + top;
  }
}

/** 컨테이너 본문 줄에서 인용 한 겹을 뗀다 — `> ` 꼴이 아니면(본문이 끊긴 줄) null. */
function stripQuote(line: string, quote: string): string | null {
  if (line === quote) return "";
  return line.startsWith(`${quote} `) ? line.slice(quote.length + 1) : null;
}

/** `start` 에서 시작하는 줄 — 줄바꿈은 빼고. */
function lineAt(whole: string, start: number): string {
  const end = whole.indexOf("\n", start);
  return whole.slice(start, end === -1 ? whole.length : end);
}

/** 줄의 인용 깊이 — 줄머리 접두의 `>` 수. */
function quoteDepthOf(line: string): number {
  return (QUOTE_PREFIX_RE.exec(line)?.[0] ?? "").split(">").length - 1;
}

/** 줄머리에서 `>` k 개까지의 인용 접두. */
function quotePrefixRe(k: number): RegExp {
  return new RegExp(`^[ \\t]*(?:>[ \\t]*){${k}}`);
}

/** 인용 접두를 k 번째 `>` 까지 자르고 공백 하나로 끝맺는다. */
function prefixTo(prefix: string, k: number): string {
  return `${(quotePrefixRe(k).exec(prefix)?.[0] ?? prefix).trimEnd()} `;
}

/** 별칭(`|300`)이 붙어도 이미지로 인식해야 image 블록으로 올라간다. */
function isImageFile(path: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico)$/i.test(stripAlias(path));
}

/** 노트(.md/.canvas)·확장자 없는 위키 대상이 아닌, 실물 첨부 파일 임베드인지(D5). */
function isAttachmentFile(target: string): boolean {
  const path = target.split("|")[0]!;
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext !== undefined && ext !== "md" && ext !== "canvas";
}

function isVideoUrl(url: string): boolean {
  return VIDEO_HOSTS.some((host) => url.includes(host));
}

function isExternalUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}
