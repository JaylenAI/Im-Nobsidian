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

/**
 * Notion File Upload API 가 받는 확장자 — 공식 문서 「Supported file types」 표를 그대로 옮겼다
 * (https://developers.notion.com/docs/working-with-files-and-media , 2026-09-28 확인).
 *
 * 표 밖의 확장자는 업로드를 만들 때 400 으로 거절된다(실측: `.base` — "Provided `filename` has
 * an extension that is not supported for the File Upload API."). 거르지 않으면 그 파일은 push 할
 * 때마다 같은 이유로 다시 실패한다 — 실볼트에서는 `.ipynb` 임베드 42건이 그랬다. Notion 이 표를
 * 넓히면 여기만 고친다.
 *
 * MIME 표({@link EXTENSION_TO_MIME})에 없는 확장자는 `application/octet-stream` 으로 보내는데,
 * API 는 그 타입을 «모름» 으로 보고 파일 이름의 확장자로 판정한다(같은 문서).
 */
const NOTION_UPLOADABLE_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    // 오디오
    "aac adts mid midi mp3 mpga m4a m4b mp4 oga ogg opus wav wma weba flac",
    // 문서
    "pdf txt csv json js ts tsx py doc dot docx dotx xls xlt xla xlsx xltx ppt pot pps ppa",
    "pptx potx rtf md markdown html htm epub xml css odt ods odp ics yaml yml tsv",
    "zip gz gzip tar 7z bz2 rar",
    // 이미지
    "gif heic jpeg jpg png svg tif tiff webp ico bmp avif apng",
    // 비디오
    "amv asf wmv avi f4v flv gifv m4v mp4 mkv webm mov qt mpeg ogv 3gp 3g2",
    // CAD · 3D
    "dwg dxf dwf rvt rfa fbx 3dm step stp iges igs stl obj 3mf gltf glb dae usdz",
  ]
    .join(" ")
    .split(" ")
    .map((ext) => `.${ext}`),
);

/** Notion 에 파일로 올릴 수 있는 형식인가 — 경로를 줘도 파일 이름의 확장자만 본다. */
export function isNotionUploadable(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = /\.[^.]+$/.exec(name)?.[0].toLowerCase();
  return ext !== undefined && NOTION_UPLOADABLE_EXTENSIONS.has(ext);
}

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
