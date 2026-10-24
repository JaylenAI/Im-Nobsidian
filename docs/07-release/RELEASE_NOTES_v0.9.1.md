# Im-Nobsidian v0.9.1 — Directory Disclosures

> **Release date:** 2026-10-25
> **Focus:** Documentation only. The code is the same as [v0.9.0](RELEASE_NOTES_v0.9.0.md). The
> Obsidian community directory reads the README on the default branch, so the disclosures it
> requires are released now, before the plugin is submitted.

---

## English

### 📝 Docs

- **Privacy and Network Use** in the README covers the account, network, files, telemetry, ads and
  payments. The plugin and the CLI talk only to the Notion API and Notion's own file hosts.
- **Community submission** now goes through the community.obsidian.md portal and its automated
  review (since 2026-05-12) instead of a pull request to `obsidian-releases`. See
  [`OBSIDIAN_PLUGIN_SUBMIT.md`](OBSIDIAN_PLUGIN_SUBMIT.md).
- A shell comment in a README code block was read as the README's title by the directory check. It
  is now plain text.
- The Korean README gained the section on several Notion workspaces in one vault.

---

## 한국어

### 📝 문서

- README 「개인정보 · 네트워크 사용」 — 계정 · 네트워크 · 파일 · 텔레메트리 · 광고 · 결제. 접속하는 곳은 Notion API 와 Notion 파일
  호스트뿐입니다.
- 커뮤니티 제출이 `obsidian-releases` PR 에서 포털 community.obsidian.md 자동 검사로 바뀐 것(2026-05-12)을
  [`OBSIDIAN_PLUGIN_SUBMIT.md`](OBSIDIAN_PLUGIN_SUBMIT.md) 에 적었습니다.
- 디렉터리 검사가 README 제목으로 읽던 코드 블록 속 셸 주석을 글로 옮겼습니다.
- 한국어 README 에 「볼트 하나에 Notion 워크스페이스 여럿」 절을 더했습니다.

---

## Verification

- **Tests:** 4,336 passed (build, lint, format, typecheck).
- **Directory checks** (`obsidianmd/obsidian-workflows`, run locally): 0 errors, 0 warnings. The
  scanner lint reports 0 errors.

---

## Upgrading

Nothing changes in behaviour. Coming from 0.4.x, read
[v0.9.0 → Upgrading](RELEASE_NOTES_v0.9.0.md#upgrading).

```bash
npm install -g im-nobsidian@0.9.1
npm install @im-nobsidian/core@0.9.1
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
