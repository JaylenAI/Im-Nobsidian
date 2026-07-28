/**
 * 볼트 렌더 규칙 — "Obsidian 에서 실제로 어떻게 보이는가"를 코드로 고정한다.
 *
 * 단위 테스트는 변환기 하나하나가 **의도대로 도는지**를 본다. 이 규칙들은 그 위에서
 * 파이프라인 전체를 통과한 결과물이 **사람 눈에 깨져 보이지 않는지**를 본다. 실제로
 * 이 트랙의 결함은 전부 후자였다 — 개별 변환은 통과하는데 합쳐 놓으면 콜아웃이
 * 코드블록으로 오파싱되거나, 표가 죽거나, 본문이 통째로 사라졌다.
 *
 * 규칙 번호(①~⑰)는 트랙 초기 실측 조사에서 붙인 결함 분류를 그대로 잇는다.
 */

/** 렌더 결함 — 볼트 산출물 한 줄만 보고 판정할 수 있는 것들. */
export interface LineRule {
  readonly code: string;
  readonly label: string;
  readonly re: RegExp;
}

export const LINE_RULES: readonly LineRule[] = [
  {
    code: "①",
    label: "콜아웃 4칸+ 들여쓰기",
    // Obsidian 은 절대 들여쓰기 4칸부터 들여쓰기 코드블록으로 오파싱한다.
    // 콜아웃이 통째로 회색 코드 상자가 되어 서식이 전부 죽는다.
    re: /^(?: {4,}|\t)+>\s*\[!/,
  },
  {
    code: "②",
    label: "토글헤딩 속성 누수",
    // NFM 전용 속성이 본문에 그대로 노출된 상태 — 토글도 접히지 않는다.
    re: /\{toggle="true"\}/,
  },
  {
    code: "③",
    label: "NFM 컨테이너 태그 누수",
    re: /<\/?(?:details|summary|callout|columns|column)\b/,
  },
  {
    code: "④",
    label: "NFM 전용 태그 누수",
    // 이름이 붙어 `<unknown>` 폴백에 걸리지 않던 태그들(P7).
    re: /<(?:table_of_contents|embed|unknown_mention|empty-block)\b/,
  },
  {
    code: "⑤",
    label: "코드펜스 4칸 들여쓰기(콜아웃 밖)",
    re: /^ {4,}```/,
  },
] as const;

/** 한 줄로는 못 잡는 구조 결함 — 앞뒤 줄 관계를 봐야 한다. */
export interface Finding {
  readonly code: string;
  readonly label: string;
  readonly line: number;
}

/**
 * 표 구분행 — 가로 공백만 허용한다. `\s` 를 쓰면 **줄바꿈까지 삼킨다**.
 *
 * 그러면 빈 표 행(`|  |  |  |`) 다음의 수평선(`---`)이 한 덩어리로 잡혀 구분행 하나가
 * 날조되고, 데이터 행이 하나 줄어든 것처럼 보인다(실측: 스위치온 5단계 노트 33→32).
 */
const SEPARATOR_BODY = "[ \\t:|-]*-{3,}";
const SEPARATOR_RE = new RegExp(`^[\\t ]*>?[\\t ]*\\|${SEPARATOR_BODY}[ \\t:|-]*\\|`);
const FENCE_RE = /^[\t ]*(?:>[\t ]*)*```/;

/** 볼트에 실제로 쓰인 마크다운을 훑어 렌더 결함을 모은다. */
export function lintRendered(pulled: string): Finding[] {
  const lines = pulled.split("\n");
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const rule of LINE_RULES) {
      if (rule.re.test(line)) findings.push({ code: rule.code, label: rule.label, line: i + 1 });
    }

    // ⑦ 표 구분행 고아 — 바로 윗줄이 같은 접두의 표 행이 아니면 표가 열리지 않는다.
    //    구분행만 덩그러니 남아 `|---|---|` 가 본문에 노출된다.
    if (SEPARATOR_RE.test(line)) {
      const prefix = /^([\t ]*>?[\t ]*)/.exec(line)![1]!;
      const prev = lines[i - 1] ?? "";
      if (!prev.startsWith(prefix) || !prev.slice(prefix.length).trimStart().startsWith("|")) {
        findings.push({ code: "⑦", label: "표 구분행 고아(표 사망)", line: i + 1 });
      }
    }
  }

  // ⑧ 코드펜스 홀수 — 짝이 안 맞으면 그 아래 문서 전체가 코드블록으로 먹힌다.
  if (lines.filter((l) => FENCE_RE.test(l)).length % 2 !== 0) {
    findings.push({ code: "⑧", label: "코드펜스 홀수(문서 잔여분 삼킴)", line: 0 });
  }

  return findings;
}

/** push 왕복 구조 보존 — 원본 NFM 대비 지표 개수가 유지되는가. */
export interface DriftMetric {
  readonly name: string;
  readonly count: (text: string) => number;
}

const countOf = (re: RegExp) => (text: string) => (text.match(re) ?? []).length;

/**
 * 표 행 수 — 원본은 `<tr>` 태그, 산출은 파이프 행이라 같은 정규식으로는 못 센다.
 *
 * 세 가지를 모두 감안해야 실제 소실만 남는다:
 *   · `<tr>` 에는 속성이 붙는다(`<tr color="gray_bg">`). 빠뜨리면 원본을 적게 세어
 *     멀쩡한 표가 "행 증식"으로 보인다.
 *   · 한 노트에 `<table>` 표와 GFM 파이프 표가 **섞여** 있다(실측 Blog.md).
 *   · 파이프 표의 구분행(`| --- |`)은 데이터가 아니다 — 단 {@link SEPARATOR_BODY} 로만
 *     세야 한다. 줄바꿈을 허용하면 구분행을 날조해 멀쩡한 표가 "행 소실"로 잡힌다.
 */
const ROW_RE = /^[\t ]*(?:>[\t ]*)*\|/gm;
const ROW_SEPARATOR_RE = new RegExp(`^[\\t ]*(?:>[\\t ]*)*\\|${SEPARATOR_BODY}`, "gm");

const tableRows = (text: string) =>
  (text.match(/<tr[^>]*>/g) ?? []).length +
  (text.match(ROW_RE) ?? []).length -
  (text.match(ROW_SEPARATOR_RE) ?? []).length;

export const DRIFT_METRICS: readonly DriftMetric[] = [
  { name: "<details>", count: countOf(/<details\b/g) },
  { name: "<callout>", count: countOf(/<callout\b/g) },
  { name: "<columns>", count: countOf(/<columns\b/g) },
  { name: "<embed>", count: countOf(/<embed\b/g) },
  { name: "<table_of_contents>", count: countOf(/<table_of_contents\b/g) },
  { name: "<unknown_mention>", count: countOf(/<unknown_mention\b/g) },
  { name: "토글헤딩", count: countOf(/\{toggle="true"\}/g) },
  { name: "코드펜스", count: countOf(/^[\t ]*```/gm) },
] as const;

export interface Drift {
  readonly name: string;
  readonly before: number;
  readonly after: number;
}

/** 원본 NFM 과 push 산출 NFM 의 구조 지표를 대조한다. */
export function structureDrift(raw: string, pushed: string): Drift[] {
  const drift: Drift[] = [];
  for (const { name, count } of DRIFT_METRICS) {
    const before = count(raw);
    const after = count(pushed);
    if (before !== after) drift.push({ name, before, after });
  }
  const rowsBefore = tableRows(raw);
  const rowsAfter = tableRows(pushed);
  if (rowsBefore !== rowsAfter) {
    drift.push({ name: "표데이터행", before: rowsBefore, after: rowsAfter });
  }
  return drift;
}

const FENCE_OF = (body: string) => {
  const m = /^([\t ]*)(`{3,}|~{3,})(.*)$/.exec(body);
  return m ? { indent: m[1]!, char: m[2]![0]!, len: m[2]!.length, info: m[3]! } : null;
};

type Fence = NonNullable<ReturnType<typeof FENCE_OF>>;

/**
 * 여는 펜스를 닫는 줄. 문자·길이(CommonMark: 여는 펜스 이상)·빈 info 는 공통 조건이고,
 * `strict` 면 들여쓰기가 같은 줄을 **우선** 고르되 하나도 없으면 첫 느슨한 줄로 물러난다.
 * NFM 이 닫는 펜스의 들여쓰기를 흘리는 경우가 실제로 있어(여는 줄 `\t\t`, 닫는 줄 열 0),
 * 물러섬이 없으면 멀쩡한 블록이 파일 끝까지 열린 것으로 잘못 잡힌다.
 */
function closeIndex(bodies: readonly string[], start: number, open: Fence, strict: boolean) {
  let loose: number | null = null;
  for (let j = start + 1; j < bodies.length; j++) {
    const f = FENCE_OF(bodies[j]!);
    if (!f || f.char !== open.char || f.len < open.len || f.info.trim() !== "") continue;
    if (!strict || f.indent === open.indent) return j;
    loose ??= j;
  }
  return loose;
}

/**
 * 코드블록을 CommonMark 규칙대로 짝지어 **개수와 코드 행수**를 센다.
 *
 * @param strict 들여쓰기가 같은 닫는 펜스를 우선한다. NFM 원본은 경계 펜스만 탭으로
 *   들여쓰고 내용은 열 0 에 두므로(비대칭 들여쓰기), 원본을 셀 때는 이 기준이 정답이다.
 *   반대로 볼트 산출물은 옵시디언이 읽는 그대로 — 들여쓰기를 보지 않고 순서대로 — 세야
 *   경계가 밀린 사실이 드러난다.
 * @param quoted 인용 접두(`> `)를 벗기고 판정한다 — 볼트 산출물은 콜아웃 안에 있다.
 */
function codeBlocks(md: string, strict: boolean, quoted: boolean) {
  const bodies = md.split("\n").map((l) => (quoted ? l.replace(/^((?:\s*>)+)\s?/, "") : l));
  let blocks = 0;
  let codeLines = 0;
  for (let i = 0; i < bodies.length; i++) {
    const open = FENCE_OF(bodies[i]!);
    if (!open) continue;
    blocks++;
    const end = closeIndex(bodies, i, open, strict) ?? bodies.length;
    codeLines += end - i - 1;
    i = end;
  }
  return { blocks, codeLines };
}

/**
 * 코드블록 경계 대조 — 원본 NFM 과 볼트 산출물의 코드블록 **개수·코드 행수**를 견준다.
 *
 * 산문 보존율·본문 삼킴 지표는 이 결함을 구조적으로 통과시킨다. 삼켜진 본문은 사라지지
 * 않고 코드블록 **안에** 그대로 남아 글자 수가 맞기 때문이다. 사람 눈에는 `>` 와 백틱이
 * 날것으로 보이는 완전한 파손인데 지표는 초록이었다 — 실측: Blog 노트에서 코드블록
 * 5→39개, 본문 8,200행이 코드로 삼켜진 채 게이트 7/7 통과.
 */
export function codeBoundaryDrift(raw: string, pulled: string): Drift[] {
  const before = codeBlocks(raw, true, false);
  const after = codeBlocks(pulled, false, true);
  const drift: Drift[] = [];
  if (before.blocks !== after.blocks)
    drift.push({ name: "코드블록수", before: before.blocks, after: after.blocks });
  if (before.codeLines !== after.codeLines)
    drift.push({ name: "코드행수", before: before.codeLines, after: after.codeLines });
  return drift;
}

/**
 * 본문 보존 — 구조가 멀쩡해도 **글이 사라지면** 아무 의미가 없다.
 *
 * 장식(마크업)은 변환으로 바뀌는 게 정상이므로 한글·영숫자만 남겨 내용만 본다.
 */
const plain = (s: string) =>
  s.replace(/\{[a-z-]+="[^"]*"\}/g, "").replace(/[^가-힣a-zA-Z0-9]/g, "");

/**
 * 판정 대상 줄인가 — URL·원시 태그가 섞인 줄은 제외한다.
 *
 * 보존 마커는 URL 을 encodeURIComponent 로 실어 `%3A%2F` 처럼 영숫자를 새로 만든다.
 * 그 줄을 그대로 비교하면 내용이 멀쩡해도 불일치로 잡혀 게이트가 통째로 못 쓰게 된다.
 */
const isProse = (l: string) => !/https?:\/\/|<[a-z_]+[ />]|^\s*(?:%%|!\[)/.test(l);

export interface ContentLoss {
  /** 연속으로 사라진 산문 줄의 최대 길이 — 5 이상이면 "문단이 통째로 삼켜졌다". */
  readonly longestRun: number;
  /** 그 구간이 시작된 원본 줄 번호. */
  readonly at: number;
  /** 판정 대상 산문 줄 중 살아남은 비율. */
  readonly ratio: number;
}

/** 원본 NFM 의 산문이 볼트 산출물에 남아 있는지 센다. */
export function contentLoss(raw: string, pulled: string): ContentLoss {
  const haystack = plain(pulled);
  const lines = raw.split("\n");

  let run = 0;
  let longestRun = 0;
  let at = 0;
  let judged = 0;
  let kept = 0;

  for (let i = 0; i < lines.length; i++) {
    const key = plain(lines[i]!);
    // 짧은 조각·비산문은 우연 일치가 잦아 판정에서 제외 — 연속 카운터는 끊지 않는다.
    if (key.length < 24 || !isProse(lines[i]!)) continue;
    judged++;
    if (haystack.includes(key.slice(0, 40))) {
      kept++;
      run = 0;
      continue;
    }
    run++;
    if (run > longestRun) {
      longestRun = run;
      at = i + 1;
    }
  }

  return { longestRun, at, ratio: judged ? kept / judged : 1 };
}

/**
 * 왕복 안정성 — pull 산출물을 push 했다가 다시 pull 하면 **내용이 같아야** 한다.
 *
 * 어긋나면 sync 를 돌릴 때마다 파일이 바뀌어 변경이 끝없이 감지된다. 다만 빈 줄·공백
 * 정규화는 두 번째 통과에서 정본으로 수렴하는 것이 정상이므로(실측 120노트 중 48노트가
 * 이 경우) 바이트가 아니라 **내용 줄**로 판정한다.
 *
 * 위치 밀림을 배제하려고 다중집합으로 비교한다. 한 줄만 끼어들어도 뒤 줄이 전부
 * "다름"으로 잡히는 순차 비교로는 실제 소실 규모를 알 수 없다.
 */
export interface RoundTripDrift {
  readonly removed: string[];
  readonly added: string[];
}

const isBlankish = (line: string) => /^[\t >]*$/.test(line);
const normalizeSpace = (line: string) => line.replace(/[\t ]+/g, " ").trimEnd();

export function roundTripDrift(first: string, second: string): RoundTripDrift {
  const diff = (a: string[], b: string[]) => {
    const tally = new Map<string, number>();
    for (const line of a) tally.set(line, (tally.get(line) ?? 0) + 1);
    for (const line of b) tally.set(line, (tally.get(line) ?? 0) - 1);
    const removed: string[] = [];
    const added: string[] = [];
    for (const [line, n] of tally) {
      for (let i = 0; i < n; i++) removed.push(line);
      for (let i = 0; i < -n; i++) added.push(line);
    }
    return { removed, added };
  };

  const raw = diff(first.split("\n"), second.split("\n"));
  // 공백 차이로 설명되는 것을 걷어내면 남는 것이 진짜 내용 드리프트다.
  return diff(
    raw.removed.filter((l) => !isBlankish(l)).map(normalizeSpace),
    raw.added.filter((l) => !isBlankish(l)).map(normalizeSpace),
  );
}
