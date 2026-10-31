/**
 * vfile 의 `minproc`(`module.exports = process`) 자리 — 모바일에는 전역 `process` 가 없어 변환할 때 던졌다. vfile 은
 * `cwd()` 만 읽는다. 데스크톱이면 예전처럼 Node 의 것.
 */
const proc = (globalThis as { process?: { cwd(): string } }).process;

export function cwd(): string {
  return proc ? proc.cwd() : "/";
}
