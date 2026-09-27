import { MARKER_BRAND_RE, MARKER_PAYLOAD_CHAR } from "../constants/markers.js";
import { decodeMarkerTarget } from "../converter/marker-url.js";

/** placeholder 를 대체할 임베드 대상 — 볼트 루트 기준 .base 경로와 별칭용 제목. */
export interface DbEmbedTarget {
  readonly basePath: string;
  readonly title: string;
}

const ID32 = "[a-f0-9]{32}";
const IDUUID = "[a-f0-9-]{32,36}";

// 제목은 encodeURIComponent 산출물이라 `%EB..` 같은 `%` 를 포함하지만, 인코딩 출력에
// `%%`(퍼센트 2연속)는 나올 수 없으므로(각 % 뒤엔 hex 2자리) lazy 매칭이 닫는 `%%` 에서
// 정확히 멈춘다.
const ENC_TITLE = "(?:&title=(.*?))?";

// A. NFM 경로 산출물: **Title** *(Notion DB)*%%brand:child-database:id=<id32>&title=<enc>%%
const INLINE_PLACEHOLDER_RE = new RegExp(
  `\\*\\*([^\\n*]*)\\*\\*\\s*\\*\\(Notion DB\\)\\*\\s*%%\\s*${MARKER_BRAND_RE}:child-database:id=(${ID32})${ENC_TITLE}\\s*%%`,
  "g",
);

// B. blocks-API 폴백 산출물(2줄 콜아웃):
//    > [!database] Title
//    > %%brand:child-database:id=<uuid>&title=<enc>%%
const CALLOUT_PLACEHOLDER_RE = new RegExp(
  `^((?:[ \\t]*>)+[ \\t]*)\\[!database\\][ \\t]*([^\\n]*)\\n(?:[ \\t]*>)+[ \\t]*%%\\s*${MARKER_BRAND_RE}:child-database:id=(${IDUUID})${ENC_TITLE}\\s*%%[ \\t]*$`,
  "gm",
);

// C. pull 의 보존 마커 주입기(PreserveMarkerInjector)가 되살린 로컬 첨부 마커 한 줄:
//    %% brand:local-file:<경로|별칭> %%
//    주입기는 파이프라인 안에서 이 재작성보다 먼저 돌아, .base 임베드가 아직 없다고 보고
//    push 때 저장한 마커를 다시 넣는다. 같은 .base 로 임베드를 되살렸으면 그 줄은 할 일이
//    끝난 노이즈다 — S-03 실측: 자식 DB 가 있는 폴더 노트를 push 한 뒤 다시 받으면 임베드
//    바로 아래에 이 줄이 남았다.
const LOCAL_FILE_MARKER_LINE_RE = new RegExp(
  `^[ \\t]*%%\\s*${MARKER_BRAND_RE}:local-file:(${MARKER_PAYLOAD_CHAR}+?)\\s*%%[ \\t]*$`,
);

function decodeTitle(encoded: string | undefined): string {
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** 위키링크 별칭으로 안전한 문자열로 정리한다(파이프/대괄호/개행 제거). */
function toAlias(...candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    const cleaned = (c ?? "").replace(/[|[\]\n]/g, "").trim();
    if (cleaned) return cleaned;
  }
  return "";
}

/**
 * pull 산출 md 의 인라인 DB placeholder 를 `![[<localFolder>/<name>.base|제목]]` 임베드로
 * 재작성한다. Obsidian Bases 임베드가 노션의 인라인 DB 뷰에 대응하는 유일한 표현이므로,
 * 이 패스가 있어야 folder note 본문에서 DB 가 "텍스트 한 줄"이 아니라 실제 표/갤러리로 보인다.
 *
 * resolve 가 null 을 반환하면(.base 미생성 — 접근 불가 DB 등) placeholder 와 마커를 그대로
 * 두어 정보를 보존하고 다음 pull 재시도에 맡긴다. 임베드로 치환된 자리는 마커가 사라지므로
 * 이 함수는 멱등이다.
 */
export function rewriteDbPlaceholders(
  content: string,
  resolve: (nohyphId: string) => DbEmbedTarget | null,
): { content: string; rewrites: number } {
  let rewrites = 0;
  const embedded = new Set<string>();

  let result = content.replace(
    INLINE_PLACEHOLDER_RE,
    (match, inlineTitle: string, id: string, encTitle: string | undefined) => {
      const target = resolve(id);
      if (!target) return match;
      const alias = toAlias(decodeTitle(encTitle), inlineTitle, target.title, "Database");
      rewrites++;
      embedded.add(target.basePath);
      return `![[${target.basePath}|${alias}]]`;
    },
  );

  result = result.replace(
    CALLOUT_PLACEHOLDER_RE,
    (match, prefix: string, calloutTitle: string, id: string, encTitle: string | undefined) => {
      const target = resolve(id.replace(/-/g, ""));
      if (!target) return match;
      const alias = toAlias(decodeTitle(encTitle), calloutTitle, target.title, "Database");
      rewrites++;
      embedded.add(target.basePath);
      return `${prefix}![[${target.basePath}|${alias}]]`;
    },
  );

  return { content: dropEmbeddedBaseMarkers(result, embedded), rewrites };
}

/**
 * 방금 임베드로 되살린 .base 를 가리키는 로컬 첨부 마커 줄({@link LOCAL_FILE_MARKER_LINE_RE})을
 * 걷어 낸다. 경로가 같거나, 마커가 파일 이름만 적었으면(옵시디언 최단 경로 링크) 이름이 같을
 * 때. 다른 첨부의 마커 줄은 그대로 둔다.
 */
function dropEmbeddedBaseMarkers(content: string, basePaths: ReadonlySet<string>): string {
  if (basePaths.size === 0) return content;
  const names = new Set([...basePaths].map((p) => p.split("/").pop()!));
  const lines = content.split("\n");
  const kept = lines.filter((line) => {
    const marker = LOCAL_FILE_MARKER_LINE_RE.exec(line);
    if (!marker) return true;
    const path = decodeMarkerTarget(marker[1]!).split("|")[0]!.trim();
    return !(basePaths.has(path) || (!path.includes("/") && names.has(path)));
  });
  return kept.length === lines.length ? content : kept.join("\n");
}
