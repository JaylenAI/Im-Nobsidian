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
        images.push({ url: target, localPath: target, isExternal: false });
        if (isPush && !isExternalUrl(target)) {
          const fileName = target.split("/").pop() ?? target;
          return `> 📎 ${fileName}\n> ${spacedMarker(`local-image:${target}`)}`;
        }
        return `![${target}](${encodeURI(target)})`;
      }
      // 비이미지 로컬 첨부 파일(pdf/mov 등): EMBED_PROTOCOL href 는 Notion 이 스킴을
      // 버려 평문으로 강등된다 — 이미지와 동일한 quote+마커 쌍으로 왕복을 보존한다(D5).
      // 노트 임베드(확장자 없음·.md·.canvas)는 위키링크/멘션 계열이므로 기존 경로 유지.
      if (isPush && !isExternalUrl(target) && isAttachmentFile(target)) {
        const fileName = target.split("/").pop() ?? target;
        return `> 📎 ${fileName}\n> ${spacedMarker(`local-file:${target}`)}`;
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

function isImageFile(path: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico)$/i.test(path);
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
