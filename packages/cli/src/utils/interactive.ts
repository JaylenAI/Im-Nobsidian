/**
 * 대화형 프롬프트를 띄울 수 있는 환경인지.
 *
 * 파이프·cron·CI 처럼 TTY 가 없는 곳에서 @inquirer 프롬프트를 띄우면 원인을 알 수 없는
 * 오류로 죽거나 입력을 기다리며 멎는다. 먼저 판정해 무엇을 어떻게 하라고 말해 준다.
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
