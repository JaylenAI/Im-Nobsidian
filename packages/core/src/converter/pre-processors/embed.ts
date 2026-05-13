import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import type { ImageReference } from "../../types/convert.js";

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
          return `> 📎 ${fileName} (로컬 이미지 — Notion API 제한으로 업로드 불가)\n> %% im-nobsidian:local-image:${target} %%`;
        }
        return `![${target}](${encodeURI(target)})`;
      }
      const encoded = encodeURIComponent(target);
      return `[${target}](im-nobsidian://embed/${encoded})`;
    });

    content = content.replace(MARKDOWN_IMAGE_REGEX, (_match, alt: string, url: string) => {
      if (isVideoUrl(url)) {
        return `%% im-nobsidian:embed:type=video&url=${encodeURIComponent(url)} %%\n[${alt || "Video"}](${url})`;
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

function isVideoUrl(url: string): boolean {
  return VIDEO_HOSTS.some((host) => url.includes(host));
}

function isExternalUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}
