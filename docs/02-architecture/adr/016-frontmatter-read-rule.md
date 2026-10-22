# ADR-016: 노트의 frontmatter 는 Obsidian 의 규칙으로 한 곳에서 읽는다

> 상태: 승인
> 결정일: 2026-09-28

## 맥락

노트의 frontmatter 를 읽는 곳이 여섯이었다 — 변환 파이프라인(`FrontmatterExtractor` ·
`PropertiesTableRestorer`), pull 뒤 관계 속성 해소(`resolveFrontmatterRelations`), 행 push 의
`parseFrontmatter`, DB 뷰(`ViewDataProvider` · `EntryEditor`). `parseFrontmatter` 를 뺀 다섯이
gray-matter 를 옵션 없이 불렀다. gray-matter 가 노트를 읽는 방식이 셋 틀렸다.

| 무엇                     | gray-matter                                                                                            | 결과                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 캐시 (S-13)              | 옵션 없이 부르면 파싱 «전에» 글을 키로 캐시 자리를 만든다. 파싱이 실패해도 `data: {}` 인 자리가 남는다 | 같은 글의 둘째 호출은 던지지 않고 «frontmatter 없음» 을 돌려준다. 캐시의 `data` 는 호출마다 같은 객체라 `EntryEditor` 가 고치면 같은 글의 다른 노트에 샌다. 캐시는 비워지지 않는다 |
| 구분선으로 시작하는 본문 | 첫 줄이 `---` 로 «시작»하면 여는 줄로 보고, 다음 `---` 로 시작하는 줄(없으면 끝)까지를 YAML 로 읽는다  | Notion 에서 구분선으로 시작하는 페이지가 이 모양으로 pull 된다. 목록은 배열, 글은 문자열이 되어 본문에서 빠지고, push 가 그것을 색인 키의 속성 블록으로 보냈다(글은 글자마다 키)   |
| `---js` 로 시작하는 노트 | 여는 줄 뒤의 말을 엔진 이름으로 읽는다. `js` · `javascript` 면 닫는 줄까지를 `eval` 한다               | Notion 의 문단 `---js` 는 pull 에서 노트의 첫 줄이 된다. pull 뒤 관계 해소 패스가 그 노트를 읽으며 **Notion 페이지의 글을 이 기기에서 JavaScript 로 실행**했다. push 도 같다       |

실측(2026-09-28, 프로브 컨테이너 `3e813b18…2614` 아래 세 페이지, dev `3950eb5` 빌드):

| 페이지           | 처음 Notion 블록                                      | pull → 로컬에서 문단 추가 → push 뒤                                                                                 |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 구분선 목록      | divider · heading_2 · 목록 둘 · divider · 문단        | `im-nobsidian:properties` 코드 블록(`'0': 항목 하나` · `'1': 항목 둘`) · divider · 문단 둘 — 제목이 사라짐          |
| 구분선 닫힘 없음 | divider · 문단 둘                                     | 속성 코드 블록(`'0': 첫` … `'20': 단`, 글자마다 키 하나) · divider — **본문이 모두 사라짐**                         |
| js 첫 줄         | 문단 `---js` · 문단 `console.log(…)` · divider · 문단 | pull 이 CLI 안에서 `NOBSI-PROBE-EVAL old-build` 를 찍음 — **실행됨**. 실행된 코드에서 `require` 를 쓸 수 있다(Node) |

Notion 의 markdown 내보내기는 `{}` 를 `\{\}` 로 바꾸므로 중괄호가 든 식은 문법 오류로 끝난다. 괄호 ·
따옴표 · 이름만 쓴 호출은 그대로 실행된다.

지정 볼트(1,271 노트)에서 `---` 로 시작하는 981개 중 3개가 구분선으로 시작하는 본문이다 — 둘은
gray-matter 가 던지고(캐시 탓에 둘째 호출부터 «frontmatter 없음»), 하나는 목록이 배열로 읽힌다.

## 결정

1. **노트의 frontmatter 는 `splitFrontmatter` 한 곳에서 읽는다**(`utils/frontmatter.ts`). gray-matter 를
   부르는 곳은 이 모듈뿐이다 — 시험이 잠근다. `parseFrontmatter` 는 이것을 감싼다.
2. **여닫는 줄은 Obsidian 과 같다**(1.13.7 `getFrontMatterInfo`). 첫 줄이 `---` 뿐이고(CRLF 허용), 그
   뒤 `---` 뿐인 첫 줄에서 닫힌다. 아니면 frontmatter 가 없다 — 입력 전체가 본문이다. `---js` ·
   `--- `(뒤 공백) · `----` 는 여는 줄이 아니다. 닫기 전에 `---` 로 시작하는 다른 줄(`----` ·
   `---x`)이 먼저 나오면 frontmatter 가 없는 노트로 본다 — Obsidian 은 더 내려가 닫지만, gray-matter 는
   그 줄에서 닫고 그 사이는 키-값 YAML 일 수 없다.
3. **그 사이 YAML 이 키-값일 때만 frontmatter 다.** 목록 · 글 · 날짜 · null 이면 frontmatter 가 없는
   노트다 — Obsidian 도 속성으로 읽지 않는다. 빈 frontmatter(`---` 두 줄)는 frontmatter 다.
4. **gray-matter 에는 옵션 객체를 넘긴다** — 캐시를 타지 않는다. YAML 이 깨졌으면 매번 던진다. 받는
   쪽이 정한다 — 페이지 변환은 본문으로 보내고, 행은 만들지 않고, `EntryEditor` 는 던진다(속성 하나만
   적은 frontmatter 로 노트를 덮어쓰지 않는다).
5. **`PropertiesTableRestorer` 는 속성 블록이 키-값으로 읽히지 않으면 블록을 본문에 둔다.** 예전에는
   블록을 걷어 내고 빈 속성을 돌려줬다 — 블록이 사라졌다.
6. **앞선 버전이 망가뜨린 Notion 페이지는 따로 되살리지 않는다.** 로컬 노트는 멀쩡하다(pull 은 받은
   그대로 쓴다). 그 노트를 고쳐 push 하면 본문이 다시 간다(E2E c1).

## 이유

- **Obsidian 과 같아야 한다.** Obsidian 이 속성으로 보는 것만 속성으로 보낸다. 구분선으로 시작하는
  본문은 Obsidian 에서 본문으로 보인다.
- **실행되는 길을 없앤다.** gray-matter 의 엔진을 덮어쓰는 옵션도 있지만, 여는 줄을 `---` 뿐으로
  좁히면 엔진 이름이 들어올 자리가 없다. 다른 이름(`---coffee` 등)도 같이 막힌다.
- **한 곳이어야 규칙이 갈리지 않는다.** 여섯 곳이 따로 부르는 동안 캐시를 피한 곳(`parseFrontmatter`)
  과 안 피한 곳이 섞였다. S-13 은 그 틈이다.

## 트레이드오프

- **동작이 바뀐다.** 릴리스 노트에 적는다.
  - 첫 줄이 `---` 뿐이 아닌 노트(`---js` · `--- ` 등)는 frontmatter 가 없는 노트다 — 그 줄부터 본문으로
    간다. 예전에는 여는 줄로 읽었다(`---js` 는 실행했다).
  - YAML 이 키-값이 아닌 `---` 구간은 본문으로 간다. 예전에는 속성 블록이 되거나 사라졌다.
  - 깨진 YAML 은 매번 실패한다. 예전에는 두 번째부터 «속성 없음» 으로 조용히 올라갔다.
- 앞선 버전이 망가뜨린 Notion 페이지는 그 노트를 고쳐 push 할 때까지 그대로다.
- YAML 파싱은 그대로 gray-matter(js-yaml 3)가 한다. 여닫는 줄만 앞에서 거른다.

## 영향

- 수정: `utils/frontmatter.ts`(`splitFrontmatter`), `converter/pre-processors/frontmatter.ts`,
  `converter/post-processors/properties-table-restorer.ts`, `sync/frontmatter-link-resolver.ts`,
  `view/view-data-provider.ts`, `view/entry-editor.ts`
- 공개 API · 상태 DB 스키마 · 설정: 변경 없음

## 검증

- 단위: 바꾼 시험 파일 6개 · 109(frontmatter 22 · 파이프라인 38 · 관계 해소 7 · `EntryEditor` 13 ·
  `ViewDataProvider` 25 · 구분선 push 4). 옛 코드에서 5 파일 87개 중 16개가 깨진다 — frontmatter 단위
  22개는 새 함수를 불러 옛 코드에서 돌 수 없다
- 전량 151 파일 · 1,994 통과(건너뜀 3 파일 · 11)
- 실데이터 E2E: `docs/06-devlog/journal/2026-09-28.md` 「frontmatter 읽기 (S-13)」 절
