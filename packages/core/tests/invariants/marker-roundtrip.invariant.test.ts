/**
 * I13 — 마커·링크 구조 라운드트립 불변식 (R6).
 *
 * R1~R3 이 봉합한 결함들은 지금까지 **오프라인 파이프라인 테스트로만** 잠겨 있었다.
 * 오프라인 하네스(`converter/roundtrip-fidelity.ts`)는 스스로 밝히듯 martian/notion-to-md
 * 를 통과하지 않는다 — 즉 "Notion 이 실제로 무엇을 돌려주는가" 는 검증 범위 밖이다.
 * 그래서 위키링크 별칭·괄호 대상·임베드·대괄호 리터럴·인용 자식·컬럼 중첩·`%` 리터럴은
 * 라이브 왕복에서 깨져도 아무 테스트도 울리지 않는 사각지대였다.
 *
 * 이 불변식이 그 사각지대를 덮는다. 실제 Notion 격리 서브트리에 push → 수렴할 때까지
 * sync → 볼트 본문에서 각 구성물의 **생존을 수치·구조로** 단언한다.
 *
 * 잠그는 결함(브랜치 이력):
 *  · D-ALIAS-LOST   위키링크 별칭이 왕복에서 대상 제목으로 바뀜        (R2)
 *  · D-WIKIPAREN    대상 이름의 괄호가 링크 문법을 깨뜨림              (R2)
 *  · D-EMBEDALIAS   임베드 별칭 소실                                  (R2)
 *  · D-BRACKET      링크가 아닌 대괄호 리터럴이 링크로 오인/소실       (R2)
 *  · D-ESCBRACKET   이스케이프 대괄호가 왕복마다 소실/번식 (R2 — 정규화 수렴, R7 공시)
 *  · D-QUOTECHILD   인용 안의 자식 블록이 인용 밖으로 튀어나옴         (R2)
 *  · D-PCT-MARKER   본문의 홑/겹 `%` 가 보존 마커로 오인되어 먹힘      (R3)
 *  · D-COLUMN-NEST  컬럼 안의 중첩 구조 소실                          (R3)
 *  · D-COLUMN-INDENT 컬럼 내부 들여쓰기 붕괴                          (R3)
 *  · R1             preserve marker 가 push 경로에 배선되지 않아 왕복 소실
 *
 * 이 불변식이 **처음 잡아낸** 결함(R6, 전부 오프라인 회귀도 함께 잠금):
 *  · D-NOTEEMBED     `![[대상]]` 을 의사 프로토콜로 올려 평문으로 영구 붕괴
 *  · D-COMMENT-PAIR  본문의 홑 `%%` 가 마커 구분자와 짝지어져 문장을 삼킴
 *  · D-WIKI-CODEFENCE 코드 구간의 `[[…]]` 까지 링크로 바꿔 Notion 화면을 깨뜨림
 *
 * 단언은 카운트/구조 기반(`.toContain` 금지) — 손실을 수치로 잡는다.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "@notionhq/client";

import {
  SKIP,
  rawNotion,
  createIsolatedRoot,
  createTmpVault,
  makeOrchestrator,
  snapshotVault,
  diffSnapshots,
  archivePages,
  cleanupVault,
  sleep,
} from "./harness.js";
import type { StateDB } from "../../src/state/state-db.js";
import {
  TOGGLE_START,
  TOGGLE_END,
  COLUMN_LIST_START,
  COLUMN_LIST_END,
  COLUMN_SEP,
} from "../../src/constants/markers.js";

/** Notion 코드블록에서 원문만 꺼내기 위한 최소 형태(SDK 유니온 전체는 불필요). */
interface CodeBlock {
  readonly type: string;
  readonly code: { readonly rich_text: readonly { readonly plain_text: string }[] };
}

/** 위키링크 대상 — 이름에 괄호를 넣어 D-WIKIPAREN 을 라이브에서 잠근다. */
const TARGET_TITLE = "대상 노트 (참고)";
const TARGET_NOTE = `---
title: ${TARGET_TITLE}
---

링크 대상 본문.
`;

/**
 * 링크·구조 구성물 집합. 한 문서에 몰아넣어 **한 번의 왕복**으로 전 구성물을 동시에
 * 검증한다(구성물별로 문서를 쪼개면 Notion 왕복 비용이 배로 든다).
 */
const LINK_NOTE = `---
title: 링크 구조
---

# 링크 구조

평범한 위키링크 [[${TARGET_TITLE}]] 하나.

별칭 위키링크 [[${TARGET_TITLE}|짧은 별칭]] 하나.

노트 임베드 별칭 ![[${TARGET_TITLE}|임베드 별칭]] 하나.

링크가 아닌 대괄호 리터럴 [그냥 대괄호] 와 이스케이프 \\[이스케이프\\] 도 그대로.

압축률 50% 달성. 겹퍼센트 리터럴 100%% 도 마커가 아니다.

인라인 코드 안 \`[[인라인 코드 안 링크]]\` 는 링크가 아니다.

\`\`\`markdown
예시: [[${TARGET_TITLE}]] 는 코드라 링크가 아니다.
\`\`\`

> 인용문 머리
>
> - 인용 안 목록 1
> - 인용 안 목록 2

> [!toggle]- 토글 제목
> 토글 안 문단.
>
> - 토글 안 목록

${TOGGLE_START}
- 레거시 토글 제목
  레거시 토글 문단.
${TOGGLE_END}

${COLUMN_LIST_START}
왼쪽 컬럼 문단.

- 왼쪽 목록
  - 왼쪽 2단계
${COLUMN_SEP}
오른쪽 컬럼 문단.

1. 오른쪽 번호
${COLUMN_LIST_END}

==형광펜 강조== 도 왕복.
`;

describe.skipIf(SKIP)("I13 마커·링크 구조 라운드트립 불변식", () => {
  let raw: Client;
  const createdPageIds: string[] = [];

  beforeAll(() => {
    raw = rawNotion();
  });

  afterAll(async () => {
    await archivePages(raw, createdPageIds);
  });

  function trackPages(stateDb: StateDB): void {
    for (const rec of stateDb.getAll()) {
      if (rec.notionPageId) createdPageIds.push(rec.notionPageId);
    }
  }

  it("링크·구조 노트: 왕복 수렴 + 구성물 무손실(R1~R3 라이브 잠금)", async () => {
    const root = await createIsolatedRoot(raw, "marker-roundtrip");
    createdPageIds.push(root);
    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root);

    await vaultFs.writeFile("대상 노트 (참고).md", TARGET_NOTE);
    await vaultFs.writeFile("링크 구조.md", LINK_NOTE);

    const push1 = await orchestrator.push();
    trackPages(stateDb);
    expect(push1.created, "두 노트 생성 실패").toBe(2);
    expect(push1.failed).toHaveLength(0);

    await sleep(2500);

    /*
     * 로컬 원본을 **지우고** pull 한다.
     *
     * sync 수렴만으로는 부족하다 — pull 이 파일을 한 번도 다시 쓰지 않으면 볼트에는
     * 여전히 로컬 원본이 남고, 그 원본에 대고 단언하면 Notion 을 한 번도 통과하지
     * 않은 채 전부 초록이 된다(거짓 안전망). 원본을 지운 뒤 복원시키면 이후 본문은
     * 정의상 Notion 이 돌려준 렌디션이다.
     */
    await vaultFs.deleteFile("대상 노트 (참고).md");
    await vaultFs.deleteFile("링크 구조.md");
    const pull1 = await orchestrator.pull();
    expect(pull1.failed).toHaveLength(0);
    expect(
      pull1.restored + pull1.created,
      "삭제한 두 노트가 Notion 에서 복원되지 않음 — 이후 단언이 무의미해진다",
    ).toBeGreaterThanOrEqual(2);

    // 수렴 루프 — 볼트가 더 이상 변하지 않고 push 변경도 0 이 될 때까지.
    const MAX = 4;
    let converged = false;
    let last = "";
    let prev = await snapshotVault(vault);
    for (let i = 0; i < MAX; i++) {
      const r = await orchestrator.sync();
      const cur = await snapshotVault(vault);
      const d = diffSnapshots(prev, cur);
      last =
        `iter#${i + 1} add=${d.added.length} chg=${d.changed.length} rm=${d.removed.length} ` +
        `push(c=${r.push.created},u=${r.push.updated})`;
      if (
        d.added.length === 0 &&
        d.changed.length === 0 &&
        d.removed.length === 0 &&
        r.push.created === 0 &&
        r.push.updated === 0
      ) {
        converged = true;
        break;
      }
      prev = cur;
      await sleep(1500);
    }
    expect(converged, `왕복 fixpoint 미수렴 — 마지막: ${last}`).toBe(true);

    // 수렴된 본문에서 구성물 생존 확인 — 가장 큰 .md 가 링크 노트.
    const snap = await snapshotVault(vault);
    const body = [...snap.values()].sort((a, b) => b.length - a.length)[0] ?? "";
    const bodyNoFm = body.replace(/^---[\s\S]*?\n---\n/, "");

    // ── 위키링크(D-WIKIPAREN · D-ALIAS-LOST) ──
    // 괄호가 든 대상이 링크 문법을 깨지 않고, 별칭 링크는 별칭을 그대로 유지해야 한다.
    const plainLink = new RegExp(`(?<!!)\\[\\[${TARGET_TITLE.replace(/[()]/g, "\\$&")}\\]\\]`, "g");
    expect(
      (bodyNoFm.match(plainLink) ?? []).length,
      "평범한 위키링크 손실(D-WIKIPAREN)",
    ).toBeGreaterThanOrEqual(1);
    expect(/\[\[[^\][]*\|짧은 별칭\]\]/.test(bodyNoFm), "위키링크 별칭 손실(D-ALIAS-LOST)").toBe(
      true,
    );

    // ── 임베드 별칭(D-EMBEDALIAS) ──
    expect(/!\[\[[^\][]*\|임베드 별칭\]\]/.test(bodyNoFm), "임베드 별칭 손실(D-EMBEDALIAS)").toBe(
      true,
    );

    // ── 대괄호 리터럴(D-BRACKET · D-ESCBRACKET) ──
    // 링크로 오인되면 `[그냥 대괄호](...)` 가 되거나 통째로 사라진다.
    expect(/(?<!\\)\[그냥 대괄호\](?!\()/.test(bodyNoFm), "대괄호 리터럴 손실(D-BRACKET)").toBe(
      true,
    );
    /*
     * 이스케이프 대괄호는 **정규화**되어 수렴한다 — 역슬래시가 보존되지는 않는다.
     * Notion 은 마크다운 이스케이프를 저장하지 못한다: `\[x\]` 를 평문 `[x]` 로 담고,
     * 내보낼 때 모든 대괄호를 다시 `\[x\]` 로 감싼다. 그 재-이스케이프를 벗기는
     * `unescapeBrackets` 는 미해결 위키링크 왕복(`[[없는 노트]]`)의 버팀목이라 되돌릴 수
     * 없고, 그래서 `\[x\]` 와 `[x]` 는 Notion 안에서 원리적으로 구별 불가능하다.
     * 여기서 잠그는 건 "역슬래시 보존" 이 아니라 **무손실·무번식 수렴**이다 — 리터럴은
     * 살아남고 왕복마다 `\\[` 로 번식하지 않는다(계층2 한계, R7 공시 대상).
     */
    expect(
      (bodyNoFm.match(/\\*\[이스케이프\\*\]/g) ?? []).length,
      "이스케이프 대괄호 소실(D-ESCBRACKET)",
    ).toBe(1);
    expect(/\\\\\[이스케이프/.test(bodyNoFm), "이스케이프 역슬래시 번식(D-ESCBRACKET)").toBe(false);

    // ── 퍼센트 리터럴(D-PCT-MARKER · D-COMMENT-PAIR) ──
    // 마커 파서가 `%`/`%%` 를 먹으면 이 문장이 잘려 나간다. 특히 `100%%` 의 `%%` 가
    // 바로 뒤 브랜드 마커의 여는 `%%` 와 짝지어지면 **그 사이 문단이 통째로** 삭제된다
    // (D-COMMENT-PAIR) — 그래서 접두가 아니라 **문장 끝까지** 단언한다.
    expect(/압축률 50% 달성/.test(bodyNoFm), "홑 퍼센트 리터럴 손실(D-PCT-MARKER)").toBe(true);
    expect(
      /겹퍼센트 리터럴 100%% 도 마커가 아니다\./.test(bodyNoFm),
      "겹 퍼센트 뒤 문장 삼킴(D-COMMENT-PAIR)",
    ).toBe(true);

    // ── 코드 구간 위키링크(D-WIKI-CODEFENCE) ──
    // 코드 안의 `[[…]]` 는 Obsidian 에서도 링크가 아니다. 예전 push 는 이걸 의사
    // 프로토콜 링크로 바꿔 Notion 화면을 URL 범벅으로 만들었는데, pull 이 되돌려서
    // **볼트 본문만 보면 초록**이었다. 그래서 Notion 쪽 블록도 함께 확인한다.
    expect(
      new RegExp(`예시: \\[\\[${TARGET_TITLE.replace(/[()]/g, "\\$&")}\\]\\]`).test(bodyNoFm),
      "코드블록 안 위키링크 손실(D-WIKI-CODEFENCE)",
    ).toBe(true);
    expect(/`\[\[인라인 코드 안 링크\]\]`/.test(bodyNoFm), "인라인 코드 안 위키링크 손실").toBe(
      true,
    );

    const linkRec = stateDb.getAll().find((r) => r.obsidianPath === "링크 구조.md");
    expect(linkRec?.notionPageId, "링크 노트의 Notion 페이지 id 미기록").toBeTruthy();
    const children = await raw.blocks.children.list({
      block_id: linkRec!.notionPageId!,
      page_size: 100,
    });
    const codeText = (children.results as unknown as CodeBlock[])
      .filter((b) => b.type === "code")
      .map((b) => b.code.rich_text.map((t) => t.plain_text).join(""))
      .join("\n");
    expect(codeText.length, "Notion 쪽 코드블록 자체가 없음").toBeGreaterThan(0);
    expect(
      codeText.includes("im-nobsidian://"),
      "Notion 코드블록에 의사 프로토콜 유출(D-WIKI-CODEFENCE)",
    ).toBe(false);
    expect(codeText.includes("[["), "Notion 코드블록의 위키링크 원문 손실").toBe(true);

    // ── 인용 자식(D-QUOTECHILD) ──
    // 자식 목록이 인용 밖으로 튀면 `> - ` 접두사를 잃는다.
    expect(
      (bodyNoFm.match(/^>\s+-\s+인용 안 목록/gm) ?? []).length,
      "인용 안 자식 목록 이탈(D-QUOTECHILD)",
    ).toBe(2);

    // 라이브 왕복은 1회에 ~10초 + 실제 Notion 쓰기라 실패 원인을 눈으로 봐야 할 때가 있다.
    // `I13_DUMP=<경로>` 로 수렴 본문을 통째로 떨궈 실측 렌디션을 확인한다(rtk 가 vitest
    // 출력을 JSON 리포터로 바꿔 console.log 는 사라지므로 파일로 쓴다).
    if (process.env["I13_DUMP"]) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env["I13_DUMP"]!, bodyNoFm, "utf-8");
    }

    /*
     * ── 토글(R1 마커 push 배선) ──
     * 라이브 경로(Notion Markdown API)의 **정준형은 콜아웃 토글**(`> [!toggle]-`)이다 —
     * Notion 은 토글을 NFM `<details>` 로 돌려주고 pull 이 콜아웃으로 되돌린다. 레거시
     * 마커형(`%%…toggle:start%%`)은 첫 왕복에서 정준형으로 **정규화**되며(수렴 후 안정),
     * 그때 제목·본문이 한 줄도 새면 안 된다. 그래서 마커 존재가 아니라 **콜아웃 2개와
     * 각 본문 줄**을 센다 — 마커만 세면 정규화된 뒤 무엇을 잃었는지 못 잡는다.
     */
    expect(
      (bodyNoFm.match(/^> \[!toggle\]-/gm) ?? []).length,
      "토글 블록 수 불일치(콜아웃형·레거시 마커형 각 1개)",
    ).toBe(2);
    expect(/^> \[!toggle\]- 토글 제목$/m.test(bodyNoFm), "토글 제목 손실").toBe(true);
    expect(/^> 토글 안 문단\.$/m.test(bodyNoFm), "토글 본문 문단 손실").toBe(true);
    expect(/^>\s+-\s+토글 안 목록$/m.test(bodyNoFm), "토글 안 자식 목록 이탈").toBe(true);
    expect(
      /^> \[!toggle\]- 레거시 토글 제목$/m.test(bodyNoFm),
      "레거시 마커형 토글 제목 손실(정규화 중 유실)",
    ).toBe(true);
    expect(
      /^> 레거시 토글 문단\.$/m.test(bodyNoFm),
      "레거시 마커형 토글 본문 손실(정규화 중 유실)",
    ).toBe(true);
    // 정규화가 끝났으면 레거시 마커 토큰은 본문에 남지 않는다(잔해 = 반쪽 변환).
    expect(bodyNoFm.includes(TOGGLE_START) || bodyNoFm.includes(TOGGLE_END), "토글 마커 잔해").toBe(
      false,
    );

    // ── 컬럼(D-COLUMN-NEST · D-COLUMN-INDENT) ──
    // pull 은 **컬럼마다** 구분 마커를 하나씩 찍는다(첫 컬럼 포함) — 소스의 1개가
    // 정준형 2개로 정규화되고 그 뒤로 안정된다.
    expect(bodyNoFm.includes(COLUMN_LIST_START), "컬럼 시작 마커 손실").toBe(true);
    expect(bodyNoFm.includes(COLUMN_LIST_END), "컬럼 종료 마커 손실").toBe(true);
    expect((bodyNoFm.match(new RegExp(COLUMN_SEP, "g")) ?? []).length, "컬럼 구분 마커 손실").toBe(
      2,
    );
    expect(/^왼쪽 컬럼 문단\.$/m.test(bodyNoFm), "왼쪽 컬럼 문단 손실").toBe(true);
    expect(/^오른쪽 컬럼 문단\.$/m.test(bodyNoFm), "오른쪽 컬럼 문단 손실").toBe(true);
    // 컬럼 안의 중첩 목록이 평탄화되면 들여쓴 줄이 사라진다.
    expect(/^\s{2,}-\s+왼쪽 2단계/m.test(bodyNoFm), "컬럼 내부 중첩 붕괴(D-COLUMN-NEST)").toBe(
      true,
    );
    expect(/^1\.\s+오른쪽 번호/m.test(bodyNoFm), "컬럼 내부 번호목록 손실(D-COLUMN-INDENT)").toBe(
      true,
    );

    // ── 형광펜 ──
    expect(/==형광펜 강조==/.test(bodyNoFm), "형광펜(highlight) 손실").toBe(true);

    await cleanupVault(vault, stateDb);
  });
});
