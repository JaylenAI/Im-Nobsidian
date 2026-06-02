/**
 * 본문 링크 충실도(fidelity) 분류기 — 회귀 상시 잠금용 측정 인프라.
 *
 * pull 결과물(.md 본문)에 남은 notion 링크/멘션을 네 부류로 분류한다:
 *
 *   1. preservedMarkers — `[text](url)%%im-nobsidian:...%%` 형태의 의도된 무손실
 *      보존 마커(copy_indicator 등). push 라운드트립 복원용으로 *일부러* 남긴 것이라
 *      결함이 아니다.
 *   2. externalLinks    — 동기화 코퍼스에 없는 외부 notion.so 링크. 위키링크로 환원할
 *      대상이 없으므로 맨 링크로 두는 게 정당하다.
 *   3. selfReferences   — 자기 자신 페이지를 가리키는 링크/멘션(블록 앵커 등). 정당.
 *   4. defects          — 동기화된 *다른* 페이지로의 미해소 링크/멘션. 이것만이 진짜
 *      충실도 결함이다(M2/M3/M4/M6 가 봉합한 대상).
 *
 * 변환 파이프라인이 완전하면 `defects.length === 0` 이어야 한다. 이 분류기를 픽스처로
 * 잠가(unit test) 두면 변환기 회귀가 즉시 드러나고, 실제 vault 에 대고 돌리면(아래
 * scripts/audit-vault.mjs) 코퍼스 전체의 충실도를 정량 측정할 수 있다.
 *
 * 마커/ID 판별은 SSOT 를 재사용한다 — 마커 브랜드는 {@link MARKER_BRAND},
 * 정규 id 는 {@link compactNotionId}. 별도 헬퍼를 만들지 않는다.
 */

import { MARKER_BRAND } from "../constants/markers.js";
import { compactNotionId } from "../utils/id.js";

/** 미해소로 남은 링크/멘션의 형태. */
export type FidelityDefectForm = "md-link" | "mention-page";

/** 진짜 충실도 결함 — 동기화된 다른 페이지로의 미해소 링크/멘션. */
export interface FidelityDefect {
  /** 미해소 형태(맨 마크다운 링크 / 미변환 mention-page 태그). */
  form: FidelityDefectForm;
  /** 대상 페이지의 정규(compact) id. */
  targetPageId: string;
  /** 대상 페이지 제목(맵에 있으면). */
  targetTitle: string | null;
  /** 결함 원문 조각(진단용). */
  raw: string;
}

/** {@link classifyBodyFidelity} 분류 결과. */
export interface FidelityClassification {
  /** `[text](url)%%im-nobsidian:...%%` — 의도된 무손실 보존 마커(결함 아님). */
  preservedMarkers: number;
  /** 코퍼스에 없는 외부 notion.so 링크(정당). */
  externalLinks: number;
  /** 자기 자신 페이지를 가리키는 링크/멘션(정당). */
  selfReferences: number;
  /** 동기화된 다른 페이지로의 미해소 링크/멘션 — 진짜 결함. */
  defects: FidelityDefect[];
}

/** 분류에 필요한 코퍼스 컨텍스트. */
export interface FidelityContext {
  /** 동기화된 전체 페이지의 정규(compact) id 집합. */
  knownPageIds: ReadonlySet<string>;
  /** 정규 id → 제목. 선택(결함 진단용). */
  titleById?: ReadonlyMap<string, string>;
  /** 이 본문이 속한 페이지의 정규 id. 자기참조 판별용. 선택. */
  ownPageId?: string;
}

/**
 * notion id 추출 정규식 — 하이픈 포함 UUID 와 32연속 hex 를 모두 인식한다.
 * `-?` 가 모두 선택이므로 단일 패턴이 두 형태를 포괄한다.
 */
const NOTION_ID_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;

/** notion.so 마크다운 링크 + 직후 보존 마커 동반 여부. group1=url, group2=마커. */
const MD_LINK_RE = new RegExp(
  `\\[[^\\]]*\\]\\((https?://[^)\\s]*notion\\.so/[^)\\s]*)\\)(\\s*%%\\s*${MARKER_BRAND}\\b)?`,
  "gi",
);

/** mention-page 태그 — self-closing `/>` 와 라벨 동반 `>..</mention-page>` 모두 포괄. */
const MENTION_PAGE_RE = /<mention-page\b[\s\S]*?(?:\/>|>[\s\S]*?<\/mention-page>)/gi;

/** 문자열에서 마지막 notion id 를 정규(compact) 형태로 추출. 없으면 null. */
function lastNotionId(text: string): string | null {
  const matches = text.match(NOTION_ID_RE);
  if (!matches || matches.length === 0) return null;
  return compactNotionId(matches[matches.length - 1]!);
}

/**
 * 본문 문자열의 notion 링크/멘션 충실도를 분류한다. 순수 함수 — I/O 없음.
 *
 * @param body  분석할 마크다운 본문(프론트매터 포함 가능; 보존 마커·위키링크는 무시됨).
 * @param ctx   코퍼스 컨텍스트(알려진 페이지 id 집합 등).
 */
export function classifyBodyFidelity(body: string, ctx: FidelityContext): FidelityClassification {
  const result: FidelityClassification = {
    preservedMarkers: 0,
    externalLinks: 0,
    selfReferences: 0,
    defects: [],
  };

  const own = ctx.ownPageId ? compactNotionId(ctx.ownPageId) : null;
  const titleOf = (id: string): string | null => ctx.titleById?.get(id) ?? null;

  const classifyId = (id: string | null, form: FidelityDefectForm, raw: string): void => {
    if (id === null) {
      // id 를 못 뽑은 링크/멘션은 외부로 간주(코퍼스 매칭 불가).
      result.externalLinks += 1;
      return;
    }
    if (own !== null && id === own) {
      result.selfReferences += 1;
      return;
    }
    if (ctx.knownPageIds.has(id)) {
      result.defects.push({ form, targetPageId: id, targetTitle: titleOf(id), raw: raw.trim() });
      return;
    }
    result.externalLinks += 1;
  };

  // 1) notion.so 마크다운 링크
  for (const m of body.matchAll(MD_LINK_RE)) {
    const url = m[1] ?? "";
    const hasMarker = Boolean(m[2]);
    if (hasMarker) {
      result.preservedMarkers += 1;
      continue;
    }
    classifyId(lastNotionId(url), "md-link", m[0]);
  }

  // 2) mention-page 태그(변환됐어야 할 잔류물)
  for (const m of body.matchAll(MENTION_PAGE_RE)) {
    classifyId(lastNotionId(m[0]), "mention-page", m[0]);
  }

  return result;
}

/** 여러 본문의 분류 결과를 합산한 코퍼스 단위 요약. */
export interface FidelitySummary {
  files: number;
  preservedMarkers: number;
  externalLinks: number;
  selfReferences: number;
  defects: number;
  /** 결함이 1건 이상인 파일 경로 → 결함 목록. */
  defectsByFile: Record<string, FidelityDefect[]>;
}

/** 파일별 분류 결과(경로 + 분류)를 코퍼스 요약으로 합산한다. */
export function summarizeFidelity(
  perFile: ReadonlyArray<{ path: string; classification: FidelityClassification }>,
): FidelitySummary {
  const summary: FidelitySummary = {
    files: perFile.length,
    preservedMarkers: 0,
    externalLinks: 0,
    selfReferences: 0,
    defects: 0,
    defectsByFile: {},
  };
  for (const { path, classification } of perFile) {
    summary.preservedMarkers += classification.preservedMarkers;
    summary.externalLinks += classification.externalLinks;
    summary.selfReferences += classification.selfReferences;
    summary.defects += classification.defects.length;
    if (classification.defects.length > 0) {
      summary.defectsByFile[path] = classification.defects;
    }
  }
  return summary;
}
