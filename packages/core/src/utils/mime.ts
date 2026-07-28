/**
 * 확장자 → MIME / Notion 블록타입 매핑의 단일 출처.
 *
 * 예전에는 ImageHandler 가 이미지 확장자만 담은 축소판 테이블을 따로 들고 있었다.
 * 그 결과 노트에 박힌 `![[문서.txt]]` 같은 임베드를 올릴 때 `application/octet-stream`
 * 으로 요청해 Notion File Upload API 가 400 으로 거절했다(실측). 업로드 경로가 둘인데
 * 테이블이 둘이면 한쪽만 고쳐지므로 여기로 합친다.
 */
export type NotionBlockType = "image" | "pdf" | "video" | "audio" | "file";

const EXTENSION_TO_BLOCK_TYPE: Record<string, NotionBlockType> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".svg": "image",
  ".webp": "image",
  ".ico": "image",
  ".bmp": "image",
  ".tiff": "image",
  ".tif": "image",
  ".avif": "image",
  ".apng": "image",
  ".heic": "image",

  ".pdf": "pdf",

  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".avi": "video",
  ".mkv": "video",
  ".flv": "video",
  ".wmv": "video",
  ".m4v": "video",
  ".mpeg": "video",
  ".ogv": "video",
  ".3gp": "video",

  ".mp3": "audio",
  ".wav": "audio",
  ".ogg": "audio",
  ".m4a": "audio",
  ".flac": "audio",
  ".aac": "audio",
  ".wma": "audio",
  ".opus": "audio",
  ".weba": "audio",
};

const EXTENSION_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".json": "application/json",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".html": "text/html",
  ".xml": "application/xml",
  ".hwp": "application/x-hwp",
  ".xls": "application/vnd.ms-excel",
  ".doc": "application/msword",
  ".ppt": "application/vnd.ms-powerpoint",
};

export function getBlockType(filename: string): NotionBlockType {
  const ext = filename.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (!ext) return "file";
  return EXTENSION_TO_BLOCK_TYPE[ext] ?? "file";
}

export function getMimeType(filename: string): string {
  const ext = filename.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (!ext) return "application/octet-stream";
  return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}
