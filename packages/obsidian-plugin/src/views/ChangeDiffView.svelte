<script lang="ts">
  import { lineDiff } from "@im-nobsidian/core";
  import type { ChangeDiff } from "@im-nobsidian/core";
  import DiffLines from "./DiffLines.svelte";

  interface Props {
    /** 두 글을 불러온다 — 원격 변경은 Notion 을 읽어 느리다. */
    load: () => Promise<ChangeDiff>;
    oldLabel: string;
    newLabel: string;
    emptyText: string;
  }

  let { load, oldLabel, newLabel, emptyText }: Props = $props();

  // 창을 여는 동안 한 번만 부른다 — 다시 그릴 때마다 Notion 을 다시 읽지 않게.
  const hunks = $derived(load().then((diff) => lineDiff(diff.before ?? "", diff.after ?? "")));

  /** 불러오지 못한 이유를 그대로 보인다 — 「불러오지 못했습니다」로 뭉개면 무엇을 할지 모른다. */
  function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
</script>

{#await hunks}
  <div class="im-nobsidian-diff-status">불러오는 중…</div>
{:then loaded}
  <DiffLines hunks={loaded} {oldLabel} {newLabel} {emptyText} />
{:catch error}
  <div class="im-nobsidian-diff-status im-nobsidian-diff-error">{reason(error)}</div>
{/await}
