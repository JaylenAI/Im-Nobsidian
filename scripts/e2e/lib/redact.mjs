#!/usr/bin/env node
/**
 * 비밀정보 redaction 필터 (stdin → stdout).
 *
 * E2E 하니스의 모든 CLI/도구 출력은 이 필터를 통과시켜 토큰·서명 URL 파라미터를
 * 마스킹한다. 줄 전체를 버리는 `grep -v` 와 달리 값만 치환하므로 진단 정보는 보존된다.
 *
 * 사용:  some-command 2>&1 | node scripts/e2e/lib/redact.mjs
 */
import { createInterface } from "node:readline";

/** [정규식, 치환] 쌍 — 순서대로 적용. 캡처그룹으로 키는 남기고 값만 가린다. */
const RULES = [
  // Notion Integration Token: ntn_XXXX...
  [/ntn_[A-Za-z0-9_-]{10,}/g, "ntn_‹REDACTED›"],
  // Bearer / Authorization 헤더
  [/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1‹REDACTED›"],
  // key=value 형태의 토큰/시크릿/서명 (URL 쿼리·로그 공통)
  [
    /\b(token|secret|signature|sig|credential|x-amz-[a-z-]+|x-amz-signature|x-amz-credential|x-amz-security-token)=([^&\s"']+)/gi,
    "$1=‹REDACTED›",
  ],
  // JSON 스타일 "token": "value"
  [/("(?:token|secret|signature|credential)"\s*:\s*")[^"]+(")/gi, "$1‹REDACTED›$2"],
];

function redactLine(line) {
  let out = line;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => process.stdout.write(redactLine(line) + "\n"));
rl.on("close", () => process.exit(0));
