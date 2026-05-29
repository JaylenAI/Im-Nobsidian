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

const require = createRequire(import.meta.url);

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

// 충돌 접미사 ` (N).md` — 본문분리/충돌의 신호 (단, 정당한 제목일 수 있어 DB와 교차검증).
const collisionRe = / \(\d+\)\.md$/;
const collisions = fs.md.filter((p) => collisionRe.test(p));

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
const violations = [];
if (collisions.length) violations.push(`충돌접미사 ${collisions.length}건`);
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
  collisions,
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
  if (collisions.length) L(`  ⚠ 충돌접미사: ${collisions.slice(0, 10).join(", ")}${collisions.length > 10 ? " …" : ""}`);
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
