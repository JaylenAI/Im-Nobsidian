import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import type { ImageReference } from "../../types/convert.js";
import { spacedMarker } from "../../constants/markers.js";
import { encodeMarkerTarget } from "../marker-url.js";

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
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

const VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com"];

export class EmbedResolver implements Processor {
  readonly name = "EmbedResolver";
  readonly order = 60;

  process(input: ProcessorInput): ProcessorOutput {
    const images: ImageReference[] = input.metadata.images ? [...input.metadata.images] : [];
    const isPush = input.context.direction === "push";

    let content = input.content.replace(
      OBSIDIAN_EMBED_REGEX,
      (
        match: string,
        lead: string,
        target: string,
        trail: string,
        offset: number,
        whole: string,
      ) => {
        const span = { offset, length: match.length, whole, lead, trail };
        if (isImageFile(target)) {
          images.push({ url: target, localPath: stripAlias(target), isExternal: false });
          if (isPush && !isExternalUrl(target)) {
            return isolate(placeholder("local-image", target), span);
          }
          return `${lead}![${target}](${encodeURI(target)})${trail}`;
        }
        // 비이미지 로컬 첨부 파일(pdf/mov 등): EMBED_PROTOCOL href 는 Notion 이 스킴을
        // 버려 평문으로 강등된다 — 이미지와 동일한 quote+마커 쌍으로 왕복을 보존한다(D5).
        if (isPush && !isExternalUrl(target) && isAttachmentFile(target)) {
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

    content = content.replace(MARKDOWN_IMAGE_REGEX, (_match, alt: string, url: string) => {
      if (isVideoUrl(url)) {
        return `${spacedMarker(`embed:type=video&url=${encodeURIComponent(url)}`)}\n[${alt || "Video"}](${url})`;
      }
      if (isExternalUrl(url)) {
        images.push({ url, isExternal: true });
      }
      return `![${alt}](${url})`;
    });

    return {
      content,
      metadata: { ...input.metadata, images },
    };
  }
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
 *     빨아들이고, quote 를 image 로 통째 교체할 때 그 글자가 같이 지워졌다.
 *  2. 빈 줄로 끊어도, **뒷줄이 공백으로 시작하면 Notion 파서가 그 문단을 앞 quote 의
 *     자식으로 중첩시킨다**. `deleteBlock(quote)` 가 자식째 날려 `주의.` 가 또 사라졌다.
 *     그래서 임베드에 붙어 있던 가로 공백은 새 줄머리로 옮기지 않고 버린다 — 문단이
 *     이미 갈린 마당에 줄머리 공백은 의미가 없다.
 *
 * 줄 전체가 공백뿐이면(목록 안 들여쓰기 등) 원래 들여쓰기를 그대로 돌려준다.
 *
 * 인용/콜아웃 줄을 임베드가 통째로 차지한 경우(`> ![[x.base]]`)에는 `>` 접두사를
 * **되돌려 쓰지 않는다**. 자리표시자는 어차피 자기 블록으로 떨어져 나가야 하므로
 * 접두사를 남기면 `>` 하나뿐인 껍데기 줄이 콜아웃 안에 눌러앉는다. 그 껍데기는
 * 왕복 1회차엔 남고 2회차엔 사라져 파일이 영영 수렴하지 않았다(실볼트 34파일 실측).
 * Notion 콜아웃 안에 첨부 블록을 넣을 수단이 없어 임베드가 콜아웃 밖으로 나가는 것은
 * 데이터 모델상 불가피하다 — 대신 흔적을 남기지 않고 깨끗하게 내보낸다.
 */
function isolate(text: string, span: EmbedSpan): string {
  const { offset, length, whole } = span;
  const beforeOnLine = whole.slice(whole.lastIndexOf("\n", offset - 1) + 1, offset);
  const afterIdx = offset + length;
  const nl = whole.indexOf("\n", afterIdx);
  const afterOnLine = whole.slice(afterIdx, nl === -1 ? whole.length : nl);

  const tail = afterOnLine.trim() === "" ? "" : "\n\n";
  // 인용 접두사를 삼킨 경우 lead 는 줄머리에서 시작하므로 앞에 빈 줄 하나면 충분하다.
  if (QUOTE_LEAD.test(span.lead)) return `${offset === 0 ? "" : "\n"}${text}${tail}`;

  const head = beforeOnLine.trim() === "" ? span.lead : "\n\n";
  return `${head}${text}${tail}`;
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
