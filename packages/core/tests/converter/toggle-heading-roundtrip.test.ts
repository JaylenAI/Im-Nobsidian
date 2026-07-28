import { describe, it, expect } from "vitest";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import {
  convertToggleHeadings,
  restoreToggleHeadings,
} from "../../src/converter/toggle-heading.js";
import { TOGGLE_HEADING_END, TOGGLE_HEADING_START } from "../../src/constants/markers.js";

// 실측 근거: `01.소프트웨어 개발 보안설계` 페이지 NFM raw 1~12행.
// NFM 은 토글 헤딩을 "속성 붙은 제목 + 탭 한 단계 들여쓴 자식" 으로 내보낸다.
const T = "\t";
const RAW = [
  `### SW 개발 보안 생명주기 {toggle="true"}`,
  `${T}요구사항 명세 → 설계 → 구현`,
  `### SW 개발 보안 3대요소 {toggle="true"}`,
  `${T}<details>`,
  `${T}<summary>기밀성</summary>`,
  `${T}${T}인가되지 않은 접근 차단`,
  `${T}</details>`,
  `## 다음 섹션`,
  `형제 문단 — 토글 밖`,
].join("\n");

describe("토글 헤딩 왕복", () => {
  it("pull 이 속성을 마커로 옮기고 자식을 열 0 으로 내린다", () => {
    const pulled = convertToggleHeadings(RAW);

    // ② 속성 누수 0
    expect(pulled).not.toContain('{toggle="true"}');
    expect(pulled).toContain(`### SW 개발 보안 3대요소 ${TOGGLE_HEADING_START}`);
    // ① 자식이 열 0 — 뒤따르는 컨테이너 변환이 들여쓰기를 재적용하지 않는다
    expect(pulled).toContain(`\n<details>\n`);
    expect(pulled).toContain(`\n<summary>기밀성</summary>\n`);
    // 중첩 한 단계만 벗긴다 — <details> 안쪽 구조는 보존
    expect(pulled).toContain(`\n${T}인가되지 않은 접근 차단\n`);
  });

  it("push 가 원본 NFM 구조를 정확히 복원한다", () => {
    expect(restoreToggleHeadings(convertToggleHeadings(RAW))).toBe(RAW);
  });

  it("끝 마커가 자식과 후속 형제의 경계를 지킨다", () => {
    const pulled = convertToggleHeadings(RAW);
    const lines = pulled.split("\n");
    const endIdx = lines.indexOf(TOGGLE_HEADING_END);
    const siblingIdx = lines.indexOf("형제 문단 — 토글 밖");

    expect(endIdx).toBeGreaterThan(-1);
    expect(siblingIdx).toBeGreaterThan(endIdx);
    // 형제는 토글 밖에 남아야 한다 — push 가 다시 들여쓰면 안 된다
    expect(restoreToggleHeadings(pulled)).toContain("\n형제 문단 — 토글 밖");
  });

  it("자식 없는 토글 헤딩은 끝 마커 없이 속성만 보존한다", () => {
    const raw = `## 빈 토글 헤딩 {toggle="true"}\n\n다음 문단`;
    const pulled = convertToggleHeadings(raw);

    expect(pulled).toContain(`## 빈 토글 헤딩 ${TOGGLE_HEADING_START}`);
    expect(pulled).not.toContain(TOGGLE_HEADING_END);
    expect(restoreToggleHeadings(pulled)).toContain('## 빈 토글 헤딩 {toggle="true"}');
  });

  it("중첩 토글 헤딩이 깊이를 유지한 채 왕복한다", () => {
    const raw = [
      `## 바깥 {toggle="true"}`,
      `${T}### 안쪽 {toggle="true"}`,
      `${T}${T}깊은 본문`,
      `${T}바깥 본문`,
    ].join("\n");

    const pulled = convertToggleHeadings(raw);
    expect(pulled).not.toContain('{toggle="true"}');
    // 끝 마커가 두 개 — 안쪽/바깥이 각자 경계를 갖는다
    expect(pulled.split("\n").filter((l) => l === TOGGLE_HEADING_END)).toHaveLength(2);
    expect(restoreToggleHeadings(pulled)).toBe(raw);
  });

  it("끝 마커가 없는 구버전 문서는 다음 동급 이상 제목까지로 폴백한다", () => {
    const legacy = [
      `### 레거시 ${TOGGLE_HEADING_START}`,
      `자식 문단`,
      `## 상위 제목`,
      `토글 밖 문단`,
    ].join("\n");

    const restored = restoreToggleHeadings(legacy);
    expect(restored).toContain('### 레거시 {toggle="true"}');
    expect(restored).toContain(`\n${T}자식 문단`);
    expect(restored).toContain("\n## 상위 제목");
    expect(restored).toContain("\n토글 밖 문단");
  });

  it("짝 없는 끝 마커는 Notion 으로 새지 않는다", () => {
    expect(restoreToggleHeadings(`문단\n${TOGGLE_HEADING_END}\n다음`)).toBe("문단\n다음");
  });

  it("전체 파이프라인에서 4칸 들여쓴 콜아웃이 생기지 않는다", () => {
    const pulled = notionEnhancedToObsidian(RAW);

    // ① 4칸 콜아웃 = Obsidian 이 코드블록으로 오파싱하는 형태
    expect(pulled.split("\n").filter((l) => /^ {4}> \[!/.test(l))).toHaveLength(0);
    expect(pulled).toContain("> [!toggle]- 기밀성");
    expect(pulled).not.toContain('{toggle="true"}');

    // push 는 토글 헤딩과 토글을 모두 되돌린다
    const pushed = obsidianToNotionEnhanced(pulled);
    expect(pushed).toContain('{toggle="true"}');
    expect(pushed).toContain("<details>");
    expect(pushed).toContain("<summary>기밀성</summary>");
  });

  it("토글 헤딩 자식의 코드펜스가 열 0 에 정렬된다", () => {
    const raw = [`## 코드 토글 {toggle="true"}`, `${T}\`\`\`python`, `print(1)`, `${T}\`\`\``].join(
      "\n",
    );

    const pulled = convertToggleHeadings(raw);
    // 펜스가 들여쓰인 채 남으면 CommonMark 펜스 규칙을 위반해 코드블록이 열리지 않는다
    expect(pulled).toContain("\n```python\n");
    expect(pulled).not.toMatch(/^[ \t]+```/m);
  });
});
