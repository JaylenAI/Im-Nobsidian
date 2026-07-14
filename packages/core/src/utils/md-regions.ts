/**
 * 펜스 코드블록(``` / ~~~) 바깥 영역에만 변환 함수를 적용한다.
 *
 * 주석 제거·각주 이스케이프·이스케이프 정규화 같은 텍스트 치환이 코드블록
 * 내부 리터럴을 오염시키지 않도록 하는 공용 가드. 인라인 코드(백틱 1개)는
 * 세그먼트 경계 판정 비용 대비 실익이 작아 다루지 않는다.
 */
/**
 * 마커 재삽입용 앵커 — idx 직전의 같은 줄 접두(최대 32자)를, 줄 첫머리면 직전
 * 비어있지 않은 줄(최대 48자)을 돌려준다. push 시점 절대 offset 은 pull 산출물에서
 * 무의미하므로, 텍스트 앵커가 위치 복원의 1차 수단이 된다.
 */
export function computeAnchor(content: string, idx: number): string {
  const before = content.slice(Math.max(0, idx - 32), idx);
  const sameLine = before.split("\n").pop() ?? "";
  if (sameLine.trim().length >= 4) return sameLine;
  const prevLines = content.slice(0, idx).split("\n");
  for (let i = prevLines.length - 2; i >= 0; i--) {
    const line = prevLines[i]!.trim();
    if (line.length > 0) return line.slice(0, 48);
  }
  return "";
}

export function mapOutsideCodeFences(content: string, fn: (segment: string) => string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (buffer.length > 0) {
      out.push(fn(buffer.join("\n")));
      buffer = [];
    }
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fence === null && fenceMatch) {
      flush();
      fence = fenceMatch[1]![0]!.repeat(3);
      out.push(line);
      continue;
    }
    if (fence !== null) {
      out.push(line);
      if (fenceMatch && fenceMatch[1]!.startsWith(fence)) {
        fence = null;
      }
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out.join("\n");
}
