import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { BlockSpacer, isCompactExport } from "../../src/converter/post-processors/block-spacer.js";
import { lintRendered, structureDrift, contentLoss, roundTripDrift } from "./rules.js";

/**
 * 볼트 렌더 게이트 — NFM 원본 코퍼스를 **파이프라인 전체**로 pull/push 하고
 * "사람 눈에 깨져 보이는가"를 판정한다.
 *
 * 기본 코퍼스는 실측된 결함 형태를 재현한 합성 노트다(사설 내용 없음).
 * 실제 워크스페이스로 돌리려면 캐시 디렉터리를 지정한다:
 *
 *   IM_NFM_CORPUS=/path/to/nfm-cache npx vitest run --root packages/core \
 *     tests/render/vault-render.gate.test.ts
 *
 * 캐시는 `.md` 파일 모음이면 되고, `index.json`(`[{path,file}]`)이 있으면 그 이름을
 * 리포트에 쓴다. 회귀가 나면 **어느 노트의 몇 번째 줄**인지까지 실패 메시지에 찍힌다.
 */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "corpus");
const CORPUS_DIR = process.env.IM_NFM_CORPUS ?? FIXTURE_DIR;

interface Note {
  readonly name: string;
  readonly raw: string;
  readonly pulled: string;
  readonly pushed: string;
}

async function loadCorpus(): Promise<Note[]> {
  const indexPath = join(CORPUS_DIR, "index.json");
  const entries: { path: string; file: string }[] = existsSync(indexPath)
    ? JSON.parse(await readFile(indexPath, "utf8"))
    : (await readdir(CORPUS_DIR))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => ({ path: f, file: f }));

  return Promise.all(
    entries.map(async ({ path, file }) => {
      const raw = await readFile(join(CORPUS_DIR, file), "utf8");
      // orchestrator 와 같은 순서로 후처리까지 통과시켜야 볼트에 실제로 쓰이는 모습이 된다.
      const pulled = new BlockSpacer().process({
        content: notionEnhancedToObsidian(raw),
        metadata: { notionExportCompact: isCompactExport(raw) },
        context: { direction: "pull", path: "markdown-api", filePath: path },
      }).content;
      return { name: path, raw, pulled, pushed: obsidianToNotionEnhanced(pulled) };
    }),
  );
}

const corpus = await loadCorpus();

describe(`볼트 렌더 게이트 (${corpus.length}노트 · ${CORPUS_DIR === FIXTURE_DIR ? "합성 코퍼스" : "지정 코퍼스"})`, () => {
  it("코퍼스가 비어 있지 않다", () => {
    expect(corpus.length, `코퍼스 없음: ${CORPUS_DIR}`).toBeGreaterThan(0);
  });

  it("볼트 산출물에 렌더 결함이 없다", () => {
    const report = corpus.flatMap(({ name, pulled }) =>
      lintRendered(pulled).map((f) => `${f.code} ${f.label} — ${name}:${f.line}`),
    );
    expect(report, `렌더 결함 ${report.length}건\n${report.slice(0, 20).join("\n")}`).toEqual([]);
  });

  it("push 왕복에서 구조가 소실·증식하지 않는다", () => {
    const report = corpus.flatMap(({ name, raw, pushed }) =>
      structureDrift(raw, pushed).map((d) => `${d.name} ${d.before}→${d.after} — ${name}`),
    );
    expect(report, `구조 드리프트 ${report.length}건\n${report.slice(0, 20).join("\n")}`).toEqual(
      [],
    );
  });

  it("본문이 통째로 삼켜지지 않는다 (연속 5행 이상 소실 0)", () => {
    const report = corpus
      .map(({ name, raw, pulled }) => ({ name, ...contentLoss(raw, pulled) }))
      .filter((r) => r.longestRun >= 5)
      .map((r) => `${r.longestRun}행 연속 소실 @${r.at} — ${r.name}`);
    expect(report, `본문 삼킴 ${report.length}노트\n${report.join("\n")}`).toEqual([]);
  });

  it("산문 보존율이 99% 이상이다", () => {
    const report = corpus
      .map(({ name, raw, pulled }) => ({ name, ...contentLoss(raw, pulled) }))
      .filter((r) => r.ratio < 0.99)
      .map((r) => `${(r.ratio * 100).toFixed(1)}% — ${r.name}`);
    expect(report, `산문 소실 ${report.length}노트\n${report.join("\n")}`).toEqual([]);
  });

  it("왕복이 안정적이다 — push 했다 다시 pull 해도 내용 줄이 그대로다", () => {
    const report = corpus.flatMap(({ name, pulled, pushed }) => {
      const drift = roundTripDrift(pulled, notionEnhancedToObsidian(pushed));
      return [
        ...drift.removed.map((l) => `- ${JSON.stringify(l)} — ${name}`),
        ...drift.added.map((l) => `+ ${JSON.stringify(l)} — ${name}`),
      ];
    });
    expect(report, `왕복 드리프트 ${report.length}줄\n${report.slice(0, 20).join("\n")}`).toEqual(
      [],
    );
  });
});
