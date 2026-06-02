/**
 * Invariant 테스트 전용 .env 로더 (의존성 없음).
 *
 * 기본 `pnpm test` 는 오프라인/고속 유지를 위해 invariant 디렉터리를 제외하고,
 * 실제 Notion 왕복이 필요한 invariant 테스트만 `test:invariants` 로 구동한다.
 * 이 setupFile 은 레포 루트의 .env(NOTION_TOKEN, NOTION_ROOT_PAGE_ID)를
 * process.env 로 주입한다. .env 가 없으면 토큰 미설정으로 간주되어
 * 각 테스트는 skipIf 로 건너뛴다.
 *
 * 보안: 토큰 값은 절대 로그로 출력하지 않는다 (키 존재 여부만 다룬다).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// packages/core/tests/invariants → 레포 루트는 4단계 상위
const envPath = resolve(import.meta.dirname, "../../../../.env");

try {
  const raw = readFileSync(envPath, "utf-8");
  for (const line of raw.split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = (match[2] ?? "").trim();
    if (key === undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // 이미 환경에 있으면 덮어쓰지 않음 (CI 의 외부 주입 우선)
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
} catch {
  // .env 부재 — invariant 테스트는 skipIf 로 건너뜀
}
