# Im-Nobsidian v0.3.1 — Steady-State Churn Elimination

> **Release date:** 2026-07-17
> **Focus:** Eliminate the residual per-pull churn that survived v0.3.0 (same-title inline-DB
> folder collisions, linked-view container double-counting), and seal two push-side round-trip
> leaks (HTML comments, new-form page-mention URLs).
> Proven on a **clean-slate 887-file real vault** (258 pages + 629 database rows): a fresh full pull rebuilds every file with
> **0 failures**, `audit-vault` reports **0 defects / 0 hash mismatches / churn-0**, and an
> immediate re-pull reports "no changes".
>
> Patch release — **no public-API or dependency changes**, fully compatible with v0.3.0.

---

## English

### 🐛 Fixed

- **Steady-state pull churn eliminated.** After v0.3.0, a no-change pull still rewrote ~66
  files every run. Two root causes are fixed:
  - **Same-title sibling inline databases** collided onto a single folder path, so their
    rows were rewritten on every pull (22 pairs in the test corpus). Sibling folders are now
    disambiguated deterministically.
  - **Linked-view containers were double-registered.** Notion's new data-source API returns a
    `data_sources` array on the _container_ itself, making a linked view indistinguishable
    from the source database; the container and its rows were both tracked and fought each
    other every pull. Ownership is now decided by **row-parent identity**, so only the real
    source is tracked. A no-change pull is now genuinely **churn-0**.
- **HTML comments no longer leak to Notion on push.** `<!-- comment -->` in markdown used to be
  pushed verbatim (a privacy leak, mirroring the `%%comment%%` issue fixed in v0.3.0). The
  comment stripper now covers HTML comments too, so they are removed before push and restored
  on pull via preserve markers — lossless round trip, never visible in Notion (extends F26).
- **Page-mention URLs resolve for the new Notion domain.** Mentions using the new
  `app.notion.com/p/…` short-URL form were left unresolved as raw links; they are now
  normalized to real page mentions just like the legacy `notion.so/…` form (F27).

### ✅ Quality

- **1285 tests passing**; lint / typecheck / build clean.
- **Proven on real data (clean slate):** the test vault was emptied and rebuilt from scratch —
  a fresh full pull produced **887 files / 0 failures** (258 pages + 629 database rows); `audit-vault` reports **0 defects,
  0 hash mismatches, churn-0**; an immediate re-pull reports **"no changes"** (idempotent);
  the torture note round-trips (push → pull) to convergence with **0 conflicts**.
- The search-based discovery fallback is confirmed **lossless**: all **258 pages** are found and
  expand to **887 files** (629 database rows); **70 linked-view containers resolve to their source
  database**, so no database row is ever tracked as a duplicate file.

### ⚠️ Known limitations (unchanged from v0.3.0)

- A **soft break** (single newline) becomes a separate paragraph block in Notion — use a blank
  line for intentional splits.
- **Consecutive empty paragraphs** collapse to a single blank line; block spacing itself is
  restored on pull.
- **Note embeds** (`![[note]]`) appear as page links in Notion and are restored as embeds on
  pull.

---

## 한국어

### 🐛 수정

- **정상상태 pull churn 근절.** v0.3.0 이후에도 무변경 pull이 매번 ~66개 파일을 다시 쓰던
  문제. 두 진범을 봉합:
  - **동명 형제 인라인 DB**가 하나의 폴더 경로로 충돌 병합돼 매 pull마다 행이 재작성되던 문제
    (테스트 코퍼스 22쌍). 형제 폴더를 결정론적으로 구분하도록 수정.
  - **linked view 컨테이너 이중 등록.** Notion 신형 data-source API가 _컨테이너_ 자체에도
    `data_sources` 배열을 채워 보내 linked view를 원본 DB와 구분할 수 없었고, 컨테이너와 행이
    모두 추적되며 매 pull마다 서로 덮어쓰던 문제. 이제 **행 parent 신원**으로 소유권을 판정해
    실제 원본만 추적 — 무변경 pull이 진정한 **churn-0**.
- **push 시 HTML 주석 비노출.** 마크다운의 `<!-- 주석 -->`이 그대로 Notion에 올라가던 정보
  유출(v0.3.0에서 봉합한 `%%주석%%`과 동일 계열). comment stripper가 HTML 주석까지 처리해
  push 전 제거하고 pull 시 보존 마커로 복원 — Notion 노출 없이 무손실 왕복 (F26 확장).
- **page mention URL 신형 도메인 해소.** 신형 `app.notion.com/p/…` 단축 URL 멘션이 원시 링크로
  방치되던 문제. 이제 레거시 `notion.so/…`와 동일하게 실제 페이지 멘션으로 정규화 (F27).

### ✅ 품질

- **1285개 테스트 통과**; lint / typecheck / build 클린.
- **실데이터 실증(clean slate):** 테스트 볼트를 완전히 비우고 처음부터 재구성 — fresh full
  pull이 **887 파일 / 0 실패**(258 페이지 + 629 DB 행) 생성; `audit-vault` **결함 0·해시 불일치 0·churn-0**;
  즉시 재 pull **"no changes"**(멱등); 고문 노트 push → pull 수렴, **충돌 0**.
- search 기반 디스커버리 폴백 **무손실** 확정: **258 페이지** 전부 발견돼 **887 파일**(629 DB 행)로
  전개; **linked view 컨테이너 70개가 원본 DB로 해소**돼 어떤 행도 중복 파일로 추적되지 않음.

### ⚠️ 알려진 제한 (v0.3.0과 동일)

- **Soft break**(단일 개행)는 Notion에서 별도 문단 블록이 된다 — 의도적 분리는 빈 줄로.
- **연속 빈 문단**은 1개로 정규화된다; 블록 간격 자체는 pull 시 복원된다.
- **노트 임베드**(`![[노트]]`)는 Notion에서 페이지 링크로 표현되고 pull 시 임베드로 복원된다.

---

## Install / Upgrade

Requires **Node.js 22.13+**. API-compatible with v0.3.0 — no config or workflow changes needed.

```bash
# CLI
npm install -g im-nobsidian@0.3.1

# Core (library)
npm install @im-nobsidian/core@0.3.1
```

Obsidian plugin: update via BRAT, or copy `main.js` / `manifest.json` / `styles.css` from the
`0.3.1` release into `.obsidian/plugins/im-nobsidian/`.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
