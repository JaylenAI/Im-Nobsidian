<script lang="ts">
  import { DIFF_SIGN } from "@im-nobsidian/core";
  import type { DiffHunk } from "@im-nobsidian/core";

  interface Props {
    /** core `lineDiff` 가 낸 묶음. */
    hunks: readonly DiffHunk[];
    /** 옛 글(지운 줄 쪽)의 이름. */
    oldLabel: string;
    /** 새 글(더한 줄 쪽)의 이름. */
    newLabel: string;
    /** 두 글이 같을 때 보일 말. */
    emptyText: string;
  }

  let { hunks, oldLabel, newLabel, emptyText }: Props = $props();

  /** 묶음 앞에 건너뛴 줄이 있나 — 첫 묶음이 글 처음부터면 없다. */
  function skipsBefore(hunk: DiffHunk, index: number): boolean {
    return index > 0 || hunk.oldStart > 1 || hunk.newStart > 1;
  }
</script>

<div class="im-nobsidian-diff-container">
  <div class="im-nobsidian-diff-header">
    <span class="im-nobsidian-diff-label-old">- {oldLabel}</span>
    <span class="im-nobsidian-diff-label-new">+ {newLabel}</span>
  </div>
  {#if hunks.length === 0}
    <div class="im-nobsidian-diff-status">{emptyText}</div>
  {:else}
    <div class="im-nobsidian-diff-body">
      {#each hunks as hunk, index (index)}
        {#if skipsBefore(hunk, index)}
          <div class="im-nobsidian-diff-gap" title="바뀌지 않은 줄은 접었습니다">⋯</div>
        {/if}
        {#each hunk.lines as line, lineIndex (lineIndex)}
          <div class="im-nobsidian-diff-line im-nobsidian-diff-{line.kind}">
            <span class="im-nobsidian-diff-num">{line.oldNumber ?? ""}</span>
            <span class="im-nobsidian-diff-num">{line.newNumber ?? ""}</span>
            <span class="im-nobsidian-diff-sign">{DIFF_SIGN[line.kind]}</span>
            <span class="im-nobsidian-diff-text">{line.text}</span>
            {#if line.noNewlineAtEnd}
              <span class="im-nobsidian-diff-eol" title="글 끝에 줄바꿈이 없습니다">↵ 없음</span>
            {/if}
          </div>
        {/each}
      {/each}
    </div>
  {/if}
</div>
