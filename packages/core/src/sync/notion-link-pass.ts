import {
  degradeUnresolvedNotionIdWikilinks,
  degradeUnresolvedNotionRelativePageLinks,
  resolveNotionIdWikilinks,
  resolveNotionRelativePageLinks,
} from "../converter/notion-id-links.js";
import type { IStateDB } from "../state/state-db-interface.js";
import { computeHash } from "../utils/hash.js";
import { getLogger } from "../utils/logger.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";
import { resolveFrontmatterRelations } from "./frontmatter-link-resolver.js";
import type { VaultFS } from "./vault-fs.js";

/**
 * pull 이 쓴 노트의 Notion 링크를 볼트 링크로 푼다 — 모두 받은 뒤 한 번 더 보는 후처리 패스.
 *
 * 변환 때는 같은 pull 에서 나중에 받는 페이지를 아직 모른다. 그래서 본문의 `[[notion:<id>]]` ·
 * 상대 url 링크(`/p/<id>`)와 frontmatter relation · people 의 원시 id 가 남는다. 모두 받은 뒤 상태
 * DB 로 `[[제목]]` 을 찾아 바꾸고, 그래도 남은 것(볼트 밖 페이지)은 동작하는 Notion URL 링크로
 * 남긴다. 바꾼 노트는 해시 · 사본 · stat 도 새 내용으로 적는다 — 아니면 다음 실행이 로컬 수정으로
 * 본다(I5).
 *
 * @returns 푼 링크 수.
 */
export async function resolveNotionLinks(
  stateDb: IStateDB,
  vaultFs: VaultFS,
  paths: string[],
): Promise<number> {
  let totalResolved = 0;
  let totalDegraded = 0;
  const allRecords = stateDb.getAll();
  const idToTitle = new Map<string, string>();
  const idToPath = new Map<string, string>();
  for (const r of allRecords) {
    if (r.notionPageId && r.obsidianPath) {
      // M4: 단일 변환 패스(resolvePageId)와 동일한 규칙으로 위키링크 텍스트를 만든다.
      const title = wikilinkTitleFromPath(r.obsidianPath);
      const cleanId = r.notionPageId.replace(/-/g, "");
      idToTitle.set(cleanId, title);
      idToTitle.set(r.notionPageId, title);
      idToPath.set(cleanId, r.obsidianPath);
    }
  }
  if (idToTitle.size === 0) return 0;

  // 두 표기(위키링크형·상대 url 형)가 **같은 역조회**를 봐야 한 표기만 해소되는 일이
  // 없다. 압축형/하이픈형 어느 쪽으로 들어와도 압축형 키로 맞춘다.
  const notionIdToPath = (id: string): string | null => idToPath.get(id.replace(/-/g, "")) ?? null;

  for (const filePath of paths) {
    if (!filePath.endsWith(".md")) continue;
    try {
      let content = await vaultFs.readFile(filePath);
      let changed = false;

      // 변환 시점 패스(resolveNotionIdWikilinks)와 **같은 함수**를 쓴다. 자체 정규식을
      // 두던 시절엔 별칭 달린 `[[notion:<id>|별칭]]` 을 아예 매치하지 못해, 같은 pull
      // 안에서 나중에 만들어진 대상을 가리키는 링크가 대상이 볼트에 실재하는데도
      // 끊긴 채 남았다(실볼트 2건).
      const idPass = resolveNotionIdWikilinks(content, notionIdToPath);
      content = idPass.markdown;
      if (idPass.resolved > 0) {
        totalResolved += idPass.resolved;
        changed = true;
      }

      // 상대 url 표기(`[라벨](/p/<id>?…)`)도 **같은 모듈의 짝 함수**로 해소한다.
      // 여기 인라인 정규식으로 두던 시절엔 같은 규칙을 두 번 적는 대가를 치렀다 —
      // 자기별칭 접기를 빠뜨려 `[[X|X]]` 45건이 굳었고(R10-C), 격하도 빠뜨려 볼트
      // 밖 페이지를 가리키는 상대링크 89건이 끊긴 채 남았다(R10-D).
      const urlPass = resolveNotionRelativePageLinks(content, notionIdToPath);
      content = urlPass.markdown;
      if (urlPass.resolved > 0) {
        totalResolved += urlPass.resolved;
        changed = true;
      }

      // frontmatter 의 relation/people 원시 UUID → `[[제목]]`. 변환 시점에는 대상
      // 페이지가 미등록이라 UUID 로 남지만, 이 post-pass 시점엔 맵이 완성돼 해소된다.
      const fm = resolveFrontmatterRelations(content, idToTitle);
      if (fm.count > 0) {
        content = fm.content;
        totalResolved += fm.count;
        changed = true;
      }

      // 해소를 전부 시도한 **뒤** 남은 것 = 볼트 밖 페이지다. 끊긴 링크로 두지 않고
      // 동작하는 Notion URL 링크로 격하한다(순서가 뒤집히면 볼트에 실재하는 대상까지
      // 외부 링크로 굳는다). **두 표기 모두** 격하한다 — 한쪽만 하면 다른 쪽 표기로
      // 들어온 볼트 밖 링크가 끊긴 채 남는다(R10-B 는 위키링크형만 고쳐 상대 url 형
      // 89건이 남았다 → R10-D).
      for (const degrade of [
        degradeUnresolvedNotionIdWikilinks,
        degradeUnresolvedNotionRelativePageLinks,
      ]) {
        const degradation = degrade(content);
        if (degradation.degraded > 0) {
          content = degradation.markdown;
          totalDegraded += degradation.degraded;
          changed = true;
        }
      }

      if (changed) {
        await vaultFs.writeFile(filePath, content);
        // 링크 정규화로 디스크 내용이 바뀌었으므로 해당 sync record 의 해시·스냅샷·stat
        // 을 새 내용으로 재동기화한다. 이걸 빠뜨리면 디스크(위키링크 형태)와 저장 해시
        // (`/p/<id>` 형태)가 영구 불일치해 매 sync마다 "modified" 로 재감지되는
        // fixpoint 위반(I5)이 발생한다. push 가 가능한 파일은 다음 push 로 self-heal
        // 되지만, child page 를 가진 폴더노트는 push 가 실패해 영영 churn 한다.
        const record = stateDb.getByPath(filePath);
        if (record) {
          const stat = await vaultFs.getFileStat(filePath);
          stateDb.transaction(() => {
            stateDb.updateHash(record.id, computeHash(content), Buffer.from(content, "utf-8"));
            if (stat) stateDb.updateStatCache(record.id, stat.mtime, stat.size);
          });
        }
      }
    } catch {
      // 파일 읽기/쓰기 실패 무시
    }
  }
  if (totalDegraded > 0) {
    getLogger().info(
      `[Im-Nobsidian] 볼트 밖 Notion 페이지 링크 ${totalDegraded}건을 URL 링크로 유지`,
    );
  }
  return totalResolved;
}
