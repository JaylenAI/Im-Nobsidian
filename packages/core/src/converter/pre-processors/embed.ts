import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import type { ImageReference } from "../../types/convert.js";
import { EMBED_PROTOCOL, spacedMarker } from "../../constants/markers.js";

const OBSIDIAN_EMBED_REGEX = /!\[\[([^\]]+)\]\]/g;
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

const VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com"];

export class EmbedResolver implements Processor {
  readonly name = "EmbedResolver";
  readonly order = 60;

  process(input: ProcessorInput): ProcessorOutput {
    const images: ImageReference[] = input.metadata.images ? [...input.metadata.images] : [];
    const isPush = input.context.direction === "push";

    let content = input.content.replace(OBSIDIAN_EMBED_REGEX, (_match, target: string) => {
      if (isImageFile(target)) {
        images.push({ url: target, localPath: stripAlias(target), isExternal: false });
        if (isPush && !isExternalUrl(target)) {
          return placeholder("local-image", target);
        }
        return `![${target}](${encodeURI(target)})`;
      }
      // 비이미지 로컬 첨부 파일(pdf/mov 등): EMBED_PROTOCOL href 는 Notion 이 스킴을
      // 버려 평문으로 강등된다 — 이미지와 동일한 quote+마커 쌍으로 왕복을 보존한다(D5).
      // 노트 임베드(확장자 없음·.md·.canvas)는 위키링크/멘션 계열이므로 기존 경로 유지.
      if (isPush && !isExternalUrl(target) && isAttachmentFile(target)) {
        return placeholder("local-file", target);
      }
      const encoded = encodeURIComponent(target);
      return `[${target}](${EMBED_PROTOCOL}${encoded})`;
    });

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
 */
function placeholder(kind: "local-image" | "local-file", target: string): string {
  const fileName = stripAlias(target).split("/").pop() ?? target;
  return `> 📎 ${fileName} ${spacedMarker(`${kind}:${target}`)}`;
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
