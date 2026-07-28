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

/**
 * 대상과 라벨로 위키링크 한 개를 만든다 — **위키링크를 뱉는 모든 경로의 유일한 출구**.
 *
 * 규칙은 하나뿐이다: 라벨이 없거나 대상과 같으면 `[[대상]]`, 다르면 `[[대상|라벨]]`.
 * `[[X|X]]` 는 `[[X]]` 와 뜻이 같지만 **같은 값이 아니다** — push 는 별칭 유무로
 * mention 과 라벨 달린 URL 링크를 가르므로, 자기별칭이 남으면 mention 이어야 할 링크가
 * 평범한 URL 링크로 나가고 왕복마다 표현이 흔들린다.
 *
 * 이 규칙은 원래 네 곳에 각자 복제돼 있었고(R10-C), 그중 후처리 패스의
 * url 형 링크 해소(`resolveNotionLinks`)만 접기를 빠뜨려 실볼트에 자기별칭
 * 45건/12파일을 쌓았다 — breadcrumb 처럼 라벨이 곧 대상 제목인 링크다.
 * "같은 계약이 여러 경로에 있는데 한 경로만 안 지킨다"는 결함군(R9a·R9e·R9f·R10-A)의
 * 재발이라, 사례를 고치는 대신 출구를 하나로 합쳐 경로 자체를 없앤다.
 */
export function formatWikilink(target: string, label?: string): string {
  return label === undefined || label === target ? `[[${target}]]` : `[[${target}|${label}]]`;
}
