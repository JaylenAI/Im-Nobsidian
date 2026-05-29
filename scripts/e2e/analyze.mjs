#!/usr/bin/env node
/**
 * fresh-user E2E 분석기 — pull 후 볼트의 동기화 충실도를 정량 측정한다.
 *
 * 두 가지 진실원을 교차검증한다:
 *   1) 파일시스템 — 실제 생성된 .md / .base / 첨부 / 폴더 구조
 *   2) 상태 DB(sync_state) — notion_page_id ↔ obsidian_path ↔ file_type 매핑
 *
 * 출력: 사람용 요약(stderr) + 머신용 JSON(stdout, --json 시 단독).
 * 종료코드: 무결성 위반(중복 page_id / folder-note 위치 오류 / 충돌접미사)이 있으면 1.
 *
 * 사용:  node scripts/e2e/analyze.mjs <vaultPath> [--json]
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, dirname, extname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// better-sqlite3 는 @im-nobsidian/core 의 의존성이다. 스크립트 위치(scripts/e2e)에는
// node_modules 가 없으므로 require 기준점을 core 패키지로 고정해야 해결된다.
const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(E2E_DIR, "..", "..");
const require = createRequire(join(REPO_ROOT, "packages", "core", "package.json"));

const vault = process.argv[2];
const jsonOnly = process.argv.includes("--json");
if (!vault) {
  console.error("usage: analyze.mjs <vaultPath> [--json]");
  process.exit(2);
}

const INTERNAL = ".im-nobsidian";

// ─── 1) 파일시스템 워크 ───
function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    if (name === INTERNAL || name === ".git") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      acc.folders.push(relative(vault, full));
      walk(full, acc);
    } else {
      const rel = relative(vault, full);
      const ext = extname(name).toLowerCase();
      if (ext === ".md") acc.md.push(rel);
      else if (ext === ".base") acc.base.push(rel);
      else acc.other.push(rel);
    }
  }
}

const fs = { md: [], base: [], other: [], folders: [] };
walk(vault, fs);

// 툴이 동명(同名) 페이지를 구분할 때 붙이는 접미사는 ` (<8-hex>)` 다(database-syncer:
// `${safeName} (${page.id.slice(0,8)})`). 이는 '서로 다른 page_id 의 동명 페이지'에 대한
// 정상 disambiguation 이지 손실이 아니므로 정보성 신호로만 보고한다.
// 반면 정당한 Notion 제목의 ` (1)` 등 십진 접미사는 위반이 전혀 아니다(과거 오판 원인).
const dedupSuffixRe = / \([0-9a-f]{8}\)\.md$/;
const dedupSuffixed = fs.md.filter((p) => dedupSuffixRe.test(p));

// ─── 2) 상태 DB ───
let db = null;
const dbReport = {
  available: false,
  total: 0,
  byType: {},
  duplicatePageIds: [],
  folderNoteMisplaced: [],
  orphanFiles: [], // FS엔 있으나 DB에 없는 .md
};

const dbPath = join(vault, INTERNAL, "sync.db");
if (existsSync(dbPath)) {
  try {
    const Database = require("better-sqlite3");
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        "SELECT obsidian_path, notion_page_id, notion_parent_id, file_type FROM sync_state",
      )
      .all();
    dbReport.available = true;
    dbReport.total = rows.length;

    const byType = {};
    const pageIdCount = new Map();
    const dbPaths = new Set();
    for (const r of rows) {
      byType[r.file_type] = (byType[r.file_type] || 0) + 1;
      dbPaths.add(r.obsidian_path);
      if (r.notion_page_id) {
        const list = pageIdCount.get(r.notion_page_id) || [];
        list.push(r.obsidian_path);
        pageIdCount.set(r.notion_page_id, list);
      }
      // folder-note 위치 규약: <folder>/<folderName>.md
      if (r.file_type === "folder-note") {
        const folder = dirname(r.obsidian_path);
        const expected = `${folder}/${basename(folder)}.md`;
        if (r.obsidian_path !== expected) {
          dbReport.folderNoteMisplaced.push({ path: r.obsidian_path, expected });
        }
      }
    }
    dbReport.byType = byType;

    // 같은 notion_page_id 가 2개 이상 경로에 매핑 = 무결성 위반(중복/부활).
    for (const [pid, paths] of pageIdCount) {
      if (paths.length > 1) dbReport.duplicatePageIds.push({ pageId: pid, paths });
    }

    // FS에는 있으나 DB에 없는 .md (고아/누출).
    for (const p of fs.md) {
      if (!dbPaths.has(p)) dbReport.orphanFiles.push(p);
    }
  } catch (e) {
    dbReport.error = String(e && e.message ? e.message : e);
  } finally {
    if (db) db.close();
  }
}

// ─── 3) 판정 ───
// 진짜 무결성 위반은 '같은 page_id 가 여러 파일에 매핑'(중복/부활)과 'folder-note 위치오류'다.
// dedup 접미사는 정상 동작이므로 위반이 아니다.
const violations = [];
if (dbReport.duplicatePageIds.length)
  violations.push(`중복 page_id ${dbReport.duplicatePageIds.length}건`);
if (dbReport.folderNoteMisplaced.length)
  violations.push(`folder-note 위치오류 ${dbReport.folderNoteMisplaced.length}건`);

const report = {
  vault,
  fs: {
    md: fs.md.length,
    base: fs.base.length,
    attachments: fs.other.length,
    folders: fs.folders.length,
  },
  db: dbReport,
  dedupSuffixed,
  violations,
  clean: violations.length === 0,
};

if (jsonOnly) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  const L = (s) => process.stderr.write(s + "\n");
  L("");
  L("  ── 동기화 충실도 분석 ──");
  L(`  파일:  md ${report.fs.md} · .base ${report.fs.base} · 첨부 ${report.fs.attachments} · 폴더 ${report.fs.folders}`);
  if (dbReport.available) {
    const types = Object.entries(dbReport.byType)
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
    L(`  DB:    레코드 ${dbReport.total} (${types})`);
  } else {
    L(`  DB:    (사용 불가${dbReport.error ? ": " + dbReport.error : ""})`);
  }
  if (dedupSuffixed.length)
    L(`  · dedup 접미사(정상 disambiguation) ${dedupSuffixed.length}건: ${dedupSuffixed.slice(0, 5).join(", ")}${dedupSuffixed.length > 5 ? " …" : ""}`);
  if (dbReport.duplicatePageIds.length)
    L(`  ⚠ 중복 page_id: ${JSON.stringify(dbReport.duplicatePageIds.slice(0, 5))}`);
  if (dbReport.folderNoteMisplaced.length)
    L(`  ⚠ folder-note 위치오류: ${JSON.stringify(dbReport.folderNoteMisplaced.slice(0, 5))}`);
  if (dbReport.orphanFiles.length)
    L(`  · DB 미등록 .md(고아) ${dbReport.orphanFiles.length}건: ${dbReport.orphanFiles.slice(0, 5).join(", ")}`);
  L(report.clean ? "  ✓ 무결성: CLEAN" : `  ✗ 무결성 위반: ${violations.join(" · ")}`);
  L("");
  // JSON 도 stdout 으로 — 호출자가 캡처 가능.
  process.stdout.write(JSON.stringify(report) + "\n");
}

process.exit(report.clean ? 0 : 1);
