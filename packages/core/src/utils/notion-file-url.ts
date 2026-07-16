/**
 * Notion 이 호스팅하는 파일 URL 판정(단일 진실원).
 *
 * notion-hosted 파일의 서명 URL(S3 presigned)은 **약 1시간 뒤 만료**된다. 이 URL 을
 * vault 에 저장하면 곧 깨진 링크가 되고, push 로 되밀면 Notion 이 이미지를
 * `external`(만료 URL 박제)로 강등해 **원본까지 오염**된다 — 실측: notion-hosted
 * 이미지의 서명 URL 을 동일 내용으로 replace 해도 블록이 재생성되며 external 로 바뀐다.
 * 따라서 pull 은 이 URL 들을 다운로드해 로컬 첨부로 대체하고, push 는 이 URL 이
 * 남아 있으면 전송을 보류해 Notion 원본을 보존해야 한다.
 */
export function isNotionHostedFileUrl(url: string): boolean {
  return (
    url.includes("secure.notion-static.com") ||
    url.includes("prod-files-secure") ||
    // 신형 파일 URL (2024+): https://file.notion.so/f/f/<space>/<file>/<name>?table=block&...
    url.includes("file.notion.so")
  );
}

/**
 * NFM(markdown API)의 `attachment:{id}:{filename}` 의사 URI.
 *
 * 통합(integration)이 접근할 수 없는 파일(예: 미공유 synced 원본 내부)에만 나타나는
 * 불투명 참조다 — 실측: id 는 블록도 file upload 도 아니어서(둘 다 404) **어떤 공개
 * API 로도 해소/다운로드가 불가능**하고, 접근 가능한 파일은 항상 서명 URL 로 나온다.
 * 다운로드 대상이 아니며, 원문 그대로 보존하는 것이 유일한 무손실 처리다.
 */
export const NOTION_ATTACHMENT_URI_RE = /^attachment:([0-9a-f-]+):(.+)$/;

export function isNotionAttachmentUri(url: string): boolean {
  return NOTION_ATTACHMENT_URI_RE.test(url);
}
