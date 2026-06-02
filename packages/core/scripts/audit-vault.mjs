#!/usr/bin/env node
/**
 * vault 충실도 + 멱등성 감사 러너 (회귀 상시 잠금용 운영 도구).
 *
 * 동기화된 vault 에 대고 두 가지를 정량 측정한다:
 *
 *   1. 충실도(fidelity)  — 본문에 남은 notion 링크/멘션을 보존마커/외부/자기참조/결함으로
 *      분류(@im-nobsidian/core 의 classifyBodyFidelity). 완전한 변환이면 결함=0.
 *   2. 멱등성(idempotency) — 디스크 파일의 sha256 이 sync_state.content_hash 와 일치하는지.
 *      불일치=0 이면 로컬 상태가 기록과 byte-identical(churn-0).
 *
 * 결함 또는 해시 불일치가 1건이라도 있으면 종료코드 1 — CI 게이트로 쓸 수 있다.
 *
 * 사용: node packages/core/scripts/audit-vault.mjs [vaultRoot] [--json]
 *       vaultRoot 미지정 시 CWD. --json 이면 요약 JSON 만 출력.
 *
 * 선행조건: `pnpm --filter @im-nobsidian/core build` (dist 에서 import).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import {
  classifyBodyFidelity,
  summarizeFidelity,
  compactNotionId,
  computeHash,
  INTERNAL_DIR,
  STATE_DB_FILE,
} from "../dist/index.js";

const root = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.cwd();
const jsonOnly = process.argv.includes("--json");
const dbPath = join(root, INTERNAL_DIR, STATE_DB_FILE);

// ── DB 로드: 코퍼스 컨텍스트 + 기록된 해시/경로 ──
const db = new Database(dbPath, { readonly: true });
const wikilinks = db.prepare("SELECT obsidian_path, notion_page_id, title FROM wikilink_map").all();
const states = db.prepare("SELECT obsidian_path, notion_page_id, content_hash FROM sync_state").all();
db.close();

const knownPageIds = new Set(wikilinks.map((r) => compactNotionId(r.notion_page_id)));
const titleById = new Map(wikilinks.map((r) => [compactNotionId(r.notion_page_id), r.title]));
const ownIdByPath = new Map(states.map((r) => [r.obsidian_path, compactNotionId(r.notion_page_id)]));
const hashByPath = new Map(states.map((r) => [r.obsidian_path, r.content_hash]));

// ── vault .md 워크 ──
const IGNORE_DIRS = new Set([INTERNAL_DIR, ".obsidian", ".trash", ".git"]);
const mdFiles = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(join(dir, e.name));
    } else if (e.name.endsWith(".md")) {
      mdFiles.push(join(dir, e.name));
    }
  }
};
walk(root);

// ── 파일별 충실도 + 멱등성 ──
const perFile = [];
let hashChecked = 0;
let hashMismatch = 0;
const mismatchSamples = [];
const trackedMd = new Set(); // sync_state 에 .md 로 기록된 경로(누락 검출용)
for (const r of states) if (r.obsidian_path.endsWith(".md")) trackedMd.add(r.obsidian_path);
const seenOnDisk = new Set();

for (const abs of mdFiles) {
  const rel = relative(root, abs);
  const content = readFileSync(abs, "utf8");
  perFile.push({
    path: rel,
    classification: classifyBodyFidelity(content, {
      knownPageIds,
      titleById,
      ownPageId: ownIdByPath.get(rel),
    }),
  });
  const stored = hashByPath.get(rel);
  if (stored !== undefined) {
    seenOnDisk.add(rel);
    hashChecked += 1;
    if (computeHash(content) !== stored) {
      hashMismatch += 1;
      if (mismatchSamples.length < 10) mismatchSamples.push(rel);
    }
  }
}

const summary = summarizeFidelity(perFile);
const missingOnDisk = [...trackedMd].filter((p) => !seenOnDisk.has(p)); // DB엔 있으나 디스크에 없는 .md

const report = {
  vault: root,
  files: { onDisk_md: mdFiles.length, tracked_total: states.length, missingOnDisk: missingOnDisk.length },
  fidelity: {
    preservedMarkers: summary.preservedMarkers,
    externalLinks: summary.externalLinks,
    selfReferences: summary.selfReferences,
    defects: summary.defects,
    defectFiles: Object.keys(summary.defectsByFile).length,
  },
  idempotency: { hashChecked, hashMismatch, churn: hashMismatch === 0 ? "churn-0 ✓" : "DRIFT ✗" },
  pass: summary.defects === 0 && hashMismatch === 0 && missingOnDisk.length === 0,
};

if (jsonOnly) {
  console.log(JSON.stringify({ ...report, defectsByFile: summary.defectsByFile }, null, 2));
} else {
  console.log("════════ vault 충실도 + 멱등성 감사 ════════");
  console.log(JSON.stringify(report, null, 2));
  if (summary.defects > 0) {
    console.log("\n── 결함 상세(최대 20) ──");
    let n = 0;
    for (const [file, defs] of Object.entries(summary.defectsByFile)) {
      for (const d of defs) {
        if (n++ >= 20) break;
        console.log(`  ${file}  →  [[${d.targetTitle ?? d.targetPageId}]]  (${d.form})`);
      }
    }
  }
  if (hashMismatch > 0) console.log("\n해시 불일치 샘플:", mismatchSamples.join(", "));
  if (missingOnDisk.length > 0) console.log("\n디스크 누락(DB엔 존재):", missingOnDisk.slice(0, 10).join(", "));
  console.log(`\n결과: ${report.pass ? "PASS ✓ (무손실·멱등)" : "FAIL ✗"}`);
}

process.exit(report.pass ? 0 : 1);
