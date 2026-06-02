/**
 * Obsidian 위키링크가 실제로 해소하는 대상 이름(파일 basename, `.md` 제거)을 경로에서 도출한다.
 *
 * 변환 단일 패스(`resolvePageId` 로 페이지 멘션→`[[제목]]`)와 후처리 패스
 * (`resolveNotionLinks` 의 본문 링크·frontmatter relation 해소)가 **동일한 규칙**으로
 * 위키링크 텍스트를 만들도록 강제하는 SSOT.
 *
 * 과거엔 단일 패스가 StateDB 의 원시 제목(`.title`)을, 후처리 패스가 sanitize 된
 * basename 을 써서 같은 페이지가 서로 다른 `[[..]]` 텍스트로 해소됐다 — 원시 제목에
 * 슬래시·콜론 등 파일명 금지문자가 있으면 단일 패스 링크가 실제 파일을 못 가리키는
 * 깨진/이중 위키링크가 됐다(M4). 두 경로 모두 이 함수를 통과시켜 불일치를 차단한다.
 */
export function wikilinkTitleFromPath(obsidianPath: string): string {
  return obsidianPath.replace(/\.md$/i, "").split("/").pop() ?? "";
}
