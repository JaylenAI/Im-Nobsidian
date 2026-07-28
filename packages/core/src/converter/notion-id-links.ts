/**
 * Notion 페이지 링크의 **두 표기를 모두** 볼트 위키링크로 되돌리고, 끝내 못 되돌린 것은
 * 동작하는 URL 로 격하하는 모듈.
 *
 *   - `[[notion:<id>]]` / `[[notion:<id>|별칭]]` — page mention 이 환원된 중간 형태
 *   - `[라벨](/p/<id>?…#앵커)` — 본문 텍스트 링크로 온 상대 url
 *
 * 두 표기는 **같은 것을 가리키는 다른 표기**이므로 규칙(해소 → 실패 시 격하)도 하나여야
 * 한다. 표기별 해소·격하를 한 쌍씩 나란히 두는 이유다 — 한쪽 갈래만 오케스트레이터에
 * 인라인으로 흩어져 있던 동안 자기별칭 접기(R10-C)와 격하(R10-D)를 연달아 빠뜨렸다.
 *
 * pull 1차 변환(`notionEnhancedToObsidian`)은 page mention 과 라벨 달린 페이지 링크를
 * 전부 이 중간 형태로 환원한다. 여기서 id → 볼트 경로 역조회로 최종 `[[제목]]` 을 만든다.
 * 볼트 밖/미추적 페이지면 중간 형태를 그대로 남긴다 — 같은 pull 의 뒤쪽에서 대상이
 * 만들어질 수 있어서다(정방향 참조). 끝내 안 만들어진 것은 pull 마감에서
 * `degradeUnresolvedNotionIdWikilinks` 가 동작하는 URL 링크로 격하한다.
 *
 * 오케스트레이터(state DB)와 테스트가 같은 규칙을 봐야 하므로 순수 함수로 분리한다.
 * **이 파일이 유일한 해소 지점이다** — 오케스트레이터의 pull 후처리(resolveNotionLinks)도
 * 자체 정규식을 두지 않고 이 함수를 부른다. 예전엔 후처리가 별칭 없는 형태만 아는
 * 정규식을 따로 갖고 있어, 변환 시점에 대상이 아직 안 만들어진 링크(같은 pull 안의
 * 정방향 참조)가 별칭을 달고 있으면 **대상이 볼트에 실재하는데도** 영영
 * `[[notion:<id>|별칭]]` 으로 남았다(실볼트 2건 실측).
 */

import { formatWikilink, wikilinkTitleFromPath } from "../utils/wikilink-title.js";

/** notion page id → 볼트 파일 경로. 미추적이면 null. */
export type NotionIdToPath = (id: string) => string | null;

export interface NotionIdWikilinkResolution {
  markdown: string;
  /** 실제로 `[[제목]]` 으로 바뀐 링크 수 — 호출자가 로그·통계에 그대로 쓴다. */
  resolved: number;
}

/**
 * id 표기는 두 가지가 다 들어온다 — 변환기가 만드는 압축형(32 hex)과 상태 DB·Notion
 * API 의 하이픈형(36자). 한쪽만 받으면 다른 쪽 경로의 링크가 통째로 미해소로 남는다.
 */
const NOTION_ID_WIKILINK_RE = /\[\[notion:([a-f0-9]{32}|[a-f0-9-]{36})(?:\|([^[\]]+))?\]\]/g;

const compactId = (id: string): string => id.replace(/-/g, "");

export function resolveNotionIdWikilinks(
  markdown: string,
  lookup: NotionIdToPath,
): NotionIdWikilinkResolution {
  let resolved = 0;
  const out = markdown.replace(
    NOTION_ID_WIKILINK_RE,
    (match, id: string, rawAlias: string | undefined) => {
      const path = lookup(id);
      if (!path) return match;
      resolved++;
      const base = wikilinkTitleFromPath(path);
      // 라벨이 id 그 자체면 별칭이 아니다 — 라벨 없는 링크를 격하했다가 되돌아온
      // 형태다(degradeUnresolvedNotionIdWikilinks 참조). `[[대상|26d2…]]` 로
      // 굳으면 사람이 읽을 수 없는 링크가 된다.
      const alias = rawAlias === compactId(id) ? undefined : rawAlias;
      // 별칭은 push 가 라벨 달린 페이지 링크로 실어 보낸 `[[대상|별칭]]` 의 별칭이다 —
      // 대상만 역조회로 채우고 별칭은 그대로 살려야 왕복이 닫힌다. 별칭이 대상 제목과
      // 같을 때 접는 규칙은 `formatWikilink` 가 갖는다(위키링크 출구는 하나뿐이다).
      return formatWikilink(base, alias);
    },
  );
  return { markdown: out, resolved };
}

export interface NotionIdWikilinkDegradation {
  markdown: string;
  /** 클릭 가능한 Notion URL 링크로 격하된 수. */
  degraded: number;
}

/**
 * 끝내 해소되지 않은 `[[notion:<id>]]` 를 **동작하는 Notion URL 링크**로 격하한다.
 * 반드시 해소를 모두 시도한 **뒤**에 부른다 — 먼저 부르면 볼트에 실재하는 대상까지
 * 외부 링크로 굳는다.
 *
 * 남겨 두면 옵시디언이 `notion:26d2…` 라는 이름의 노트를 가리키는 **끊긴 링크**로
 * 그린다. 클릭하면 그 이름의 빈 노트를 만들자고 하니, 정보 보존은커녕 볼트를 오염시킨다.
 * 같은 상황에서 url 기반 링크는 이미 동작하는 `https://www.notion.so/<id>` 로 남아
 * 있었다 — 한쪽 경로만 죽은 링크를 만들던 비대칭을 없앤다(실볼트 25건/16파일).
 *
 * 왕복도 닫힌다: 격하형 `[라벨](https://www.notion.so/<id>)` 은 pull 1차 변환의
 * 라벨 달린 페이지 링크 규칙이 다시 `[[notion:<id>|라벨]]` 로 환원하므로 id 가 살아
 * 있고, 그 페이지가 나중에 볼트에 들어오면 그때 정식 위키링크로 해소된다.
 */
export function degradeUnresolvedNotionIdWikilinks(markdown: string): NotionIdWikilinkDegradation {
  let degraded = 0;
  const out = markdown.replace(
    NOTION_ID_WIKILINK_RE,
    (_match, id: string, alias: string | undefined) => {
      degraded++;
      const compact = compactId(id);
      // 라벨 없는 mention(`<mention-page url=…/>`)은 Notion 이 제목을 안 주므로
      // id 를 라벨로 쓴다. 읽기 좋진 않지만 **동작하는** 링크이고, 해소 경로가
      // 이 라벨을 별칭으로 오인하지 않도록 위에서 되돌린다.
      return `[${alias ?? compact}](https://www.notion.so/${compact})`;
    },
  );
  return { markdown: out, degraded };
}

/**
 * Notion 내부 페이지 링크의 **상대 url 표기** — `/<id>?pvs=N`(구형), `/p/<id>?...`(신형).
 * 뒤에 `#<blockId>` 앵커가 붙기도 한다(각주가 대표적 — 실볼트 89건 중 80건).
 *
 * 쿼리와 앵커를 **따로** 잡는다. 예전엔 `\?[^)]*` 하나로 뭉뚱그려 앵커까지 삼켰는데,
 * 격하할 때 앵커를 살리려면 분리돼 있어야 한다. 해소 경로는 예전과 똑같이 앵커를
 * 버린다 — Notion 블록 id 는 옵시디언의 `[[노트#제목]]` 앵커가 아니라서, 옮겨 붙이면
 * 오히려 노트 안의 없는 제목을 가리키는 끊긴 링크가 된다.
 */
const NOTION_RELATIVE_PAGE_LINK_RE =
  /\[([^\]]+)\]\(\/(?:p\/)?([a-f0-9]{32})(?:\?[^)#]*)?(?:#([^)]*))?\)/g;

/**
 * `[라벨](/p/<id>)` 형태의 내부 페이지 링크를 볼트 위키링크로 해소한다.
 *
 * `[[notion:<id>]]` 표기와 **같은 것을 가리키는 다른 표기**다 — Notion 이 page mention
 * 은 mention 태그로, 본문 텍스트 안의 페이지 링크는 상대 url 로 내려주기 때문에 두
 * 갈래가 생긴다. 규칙(역조회 → 위키링크, 실패 시 격하)은 하나여야 하므로 해소·격하
 * 한 쌍을 `[[notion:]]` 쌍 바로 옆에 둔다. 이 갈래만 오케스트레이터 안에 인라인
 * 정규식으로 흩어져 있던 동안 자기별칭 접기를 빠뜨렸고(R10-C), 격하도 빠뜨렸다(R10-D).
 */
export function resolveNotionRelativePageLinks(
  markdown: string,
  lookup: NotionIdToPath,
): NotionIdWikilinkResolution {
  let resolved = 0;
  const out = markdown.replace(NOTION_RELATIVE_PAGE_LINK_RE, (match, label: string, id: string) => {
    const path = lookup(id);
    if (!path) return match;
    resolved++;
    return formatWikilink(wikilinkTitleFromPath(path), label);
  });
  return { markdown: out, resolved };
}

/**
 * 끝내 해소되지 않은 상대 페이지 링크를 **절대 Notion URL** 로 격하한다.
 * `degradeUnresolvedNotionIdWikilinks` 와 같은 이유·같은 순서 제약을 갖는다 —
 * 해소를 모두 시도한 **뒤**에 부른다.
 *
 * 상대 경로 `/p/<id>` 는 Notion 앱 안에서만 뜻이 있다. 옵시디언은 이걸 볼트 루트
 * 기준 경로로 읽어 `p/<id>` 라는 없는 파일을 가리키는 **끊긴 링크**로 그린다 —
 * `[[notion:<id>]]` 를 남겨 뒀을 때(R10-B)와 정확히 같은 증상이고, 같은 처방을
 * 한쪽 표기에만 적용해 뒀던 것이 결함이다(실볼트 89건/10파일, 대상 11개 전부
 * 볼트 밖 페이지 — 상태 DB 대조로 확인).
 *
 * 앵커는 살린다. 89건 중 80건이 각주(`[¹](/…#<blockId>)`)라 앵커를 버리면 모두
 * 같은 페이지 최상단으로 떨어져 각주가 각주 구실을 못 한다.
 */
export function degradeUnresolvedNotionRelativePageLinks(
  markdown: string,
): NotionIdWikilinkDegradation {
  let degraded = 0;
  const out = markdown.replace(
    NOTION_RELATIVE_PAGE_LINK_RE,
    (_match, label: string, id: string, anchor: string | undefined) => {
      degraded++;
      // 앵커 없는 형태는 다음 pull 에서 `[[notion:<id>|라벨]]` 로 환원됐다가 R10-B 격하로
      // 똑같은 URL 이 되고, 앵커 있는 형태는 환원 정규식이 id 뒤 `)` 를 요구해 아예
      // 매치되지 않는다 — 어느 쪽이든 두 번째 pull 이 이 줄을 다시 바꾸지 않는다(고정점).
      return `[${label}](https://www.notion.so/${id}${anchor === undefined ? "" : `#${anchor}`})`;
    },
  );
  return { markdown: out, degraded };
}
