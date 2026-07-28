#!/usr/bin/env node
/**
 * fresh-user E2E 분석기 — pull 후 볼트의 동기화 충실도를 정량 측정한다.
 *
 * 세 가지 진실원을 교차검증한다:
 *   1) 파일시스템 — 실제 생성된 .md / .base / 첨부 / 폴더 구조
 *   2) 상태 DB(sync_state) — notion_page_id ↔ obsidian_path ↔ file_type 매핑
 *   3) 마크다운 본문 — 볼트에 쓰인 글이 Obsidian 에서 깨져 보이지 않는가
 *
 * 3) 이 뒤늦게 붙은 이유를 남겨 둔다. 1)·2) 만 보던 시절 이 분석기는 **한 노트의 본문
 * 8,200행이 코드블록 안으로 삼켜진 볼트에 "무결성 CLEAN"** 을 찍었다(P11). 파일 개수도
 * 맞고 page_id 매핑도 멀쩡했기 때문이다 — 본문을 한 글자도 읽지 않으니 당연했다.
 * 사람이 여는 것은 본문이다.
 *
 * 출력: 사람용 요약(stderr) + 머신용 JSON(stdout, --json 시 단독).
 * 종료코드: 무결성 위반(중복 page_id / folder-note 위치 오류 / 렌더 결함)이 있으면 1.
 *
 * 사용:  node scripts/e2e/analyze.mjs <vaultPath> [--json]
 */
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative, basename, dirname, extname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// 렌더 감사는 core 가 출하하는 규칙을 그대로 쓴다 — 하니스가 게이트와 다른 잣대를 들면
// 한쪽만 초록인 상태가 생긴다. 루트 node_modules 에 워크스페이스 링크가 없으므로
// (pnpm) 빌드 산출물을 상대경로로 직접 가리킨다. 하니스는 어차피 빌드 후 실행된다.
import { lintRenderedMarkdown } from "../../packages/core/dist/index.js";

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
  orphanFiles: [], // FS엔 있으나 DB에 없는 .md (고아/누출)
  missingFiles: [], // DB엔 있으나 FS에 없는 레코드 (조용한 소실)
};

const dbPath = join(vault, INTERNAL, "sync.db");
if (existsSync(dbPath)) {
  try {
    const Database = require("better-sqlite3");
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT obsidian_path, notion_page_id, notion_parent_id, file_type FROM sync_state")
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

    // 반대 방향 — DB엔 추적 레코드가 있는데 실물이 없는 경우. 이 축이 없던 탓에 R13
    // (원격 무변경 db-row 의 로컬 삭제 미복원)이 모든 게이트를 통과했다: 개수 대조는
    // FS→DB 한 방향만 봤고, verify 는 상태 DB 의 id 집합끼리 맞춰 레코드만 있으면
    // "완결"이었으며, repull churn 은 그 행을 건너뛰니 애초에 0 이었다.
    // folder-only 의 실체는 폴더지만 existsSync 는 폴더도 참이므로 예외가 필요 없다.
    for (const r of rows) {
      if (!existsSync(join(vault, r.obsidian_path))) {
        dbReport.missingFiles.push({ path: r.obsidian_path, fileType: r.file_type });
      }
    }
  } catch (e) {
    dbReport.error = String(e && e.message ? e.message : e);
  } finally {
    if (db) db.close();
  }
}

// ─── 3) 마크다운 본문 렌더 감사 ───
// 원본 대조 없이 파일 하나만 보고 판정 가능한 것만 본다(core 의 lintRenderedMarkdown).
// 원본 NFM 과 견주는 지표(코드블록 경계 드리프트 등)는 여기서 못 잡는다 — 볼트에는
// 대조할 원본이 없고 sync.db 의 base_snapshot 도 '변환 후' 마크다운이기 때문이다.
const renderReport = { scanned: 0, defects: 0, byCode: {}, files: [] };
for (const rel of fs.md) {
  let text;
  try {
    text = readFileSync(join(vault, rel), "utf8");
  } catch {
    continue;
  }
  renderReport.scanned++;
  const findings = lintRenderedMarkdown(text);
  if (!findings.length) continue;
  renderReport.defects += findings.length;
  for (const f of findings) {
    renderReport.byCode[f.code] = (renderReport.byCode[f.code] || 0) + 1;
  }
  renderReport.files.push({
    path: rel,
    count: findings.length,
    first: findings.slice(0, 3).map((f) => `${f.code} ${f.label} L${f.line}`),
  });
}

// ─── 4) 판정 ───
// 진짜 무결성 위반은 '같은 page_id 가 여러 파일에 매핑'(중복/부활), 'folder-note 위치오류',
// '추적 중인데 실물이 없음'(양방향 대조), 그리고 '본문이 깨져 보이는 노트'다.
// dedup 접미사는 정상 동작이므로 위반이 아니다.
const violations = [];
if (dbReport.duplicatePageIds.length)
  violations.push(`중복 page_id ${dbReport.duplicatePageIds.length}건`);
if (dbReport.folderNoteMisplaced.length)
  violations.push(`folder-note 위치오류 ${dbReport.folderNoteMisplaced.length}건`);
if (dbReport.missingFiles.length)
  violations.push(`추적 중인데 실물 없음 ${dbReport.missingFiles.length}건`);
if (renderReport.files.length)
  violations.push(`렌더 결함 ${renderReport.files.length}노트 ${renderReport.defects}건`);

const report = {
  vault,
  fs: {
    md: fs.md.length,
    base: fs.base.length,
    attachments: fs.other.length,
    folders: fs.folders.length,
  },
  db: dbReport,
  render: renderReport,
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
  L(
    `  파일:  md ${report.fs.md} · .base ${report.fs.base} · 첨부 ${report.fs.attachments} · 폴더 ${report.fs.folders}`,
  );
  if (dbReport.available) {
    const types = Object.entries(dbReport.byType)
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
    L(`  DB:    레코드 ${dbReport.total} (${types})`);
  } else {
    L(`  DB:    (사용 불가${dbReport.error ? ": " + dbReport.error : ""})`);
  }
  const rc = Object.entries(renderReport.byCode)
    .map(([k, v]) => `${k}${v}`)
    .join(" ");
  L(
    renderReport.files.length
      ? `  렌더:  ${renderReport.scanned}노트 스캔 · ⚠ 결함 ${renderReport.files.length}노트 ${renderReport.defects}건 (${rc})`
      : `  렌더:  ${renderReport.scanned}노트 스캔 · 결함 0건`,
  );
  for (const f of renderReport.files.slice(0, 10)) {
    L(`         ✗ ${f.path} — ${f.first.join(" / ")}${f.count > 3 ? ` …+${f.count - 3}` : ""}`);
  }
  if (renderReport.files.length > 10) L(`         … 외 ${renderReport.files.length - 10}노트`);
  if (dedupSuffixed.length)
    L(
      `  · dedup 접미사(정상 disambiguation) ${dedupSuffixed.length}건: ${dedupSuffixed.slice(0, 5).join(", ")}${dedupSuffixed.length > 5 ? " …" : ""}`,
    );
  if (dbReport.duplicatePageIds.length)
    L(`  ⚠ 중복 page_id: ${JSON.stringify(dbReport.duplicatePageIds.slice(0, 5))}`);
  if (dbReport.folderNoteMisplaced.length)
    L(`  ⚠ folder-note 위치오류: ${JSON.stringify(dbReport.folderNoteMisplaced.slice(0, 5))}`);
  if (dbReport.orphanFiles.length)
    L(
      `  · DB 미등록 .md(고아) ${dbReport.orphanFiles.length}건: ${dbReport.orphanFiles.slice(0, 5).join(", ")}`,
    );
  if (dbReport.missingFiles.length) {
    L(`  ⚠ 추적 중인데 실물 없음 ${dbReport.missingFiles.length}건:`);
    for (const m of dbReport.missingFiles.slice(0, 10)) L(`         ✗ ${m.path} [${m.fileType}]`);
    if (dbReport.missingFiles.length > 10)
      L(`         … 외 ${dbReport.missingFiles.length - 10}건`);
  }
  L(report.clean ? "  ✓ 무결성: CLEAN" : `  ✗ 무결성 위반: ${violations.join(" · ")}`);
  L("");
  // JSON 도 stdout 으로 — 호출자가 캡처 가능.
  process.stdout.write(JSON.stringify(report) + "\n");
}

process.exit(report.clean ? 0 : 1);
