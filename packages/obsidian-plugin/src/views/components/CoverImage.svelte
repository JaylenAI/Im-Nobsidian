<script lang="ts">
  interface Props {
    src?: string;
    alt?: string;
    aspect?: "contain" | "cover";
    size?: "small" | "medium" | "large";
  }

  let { src, alt = "", aspect = "cover", size = "medium" }: Props = $props();

  const heightMap = { small: 100, medium: 160, large: 240 };
  const height = $derived(heightMap[size]);
</script>

{#if src}
  <div class="im-cover" style="height: {height}px;">
    <img {src} {alt} class="im-cover-img" style="object-fit: {aspect};" />
  </div>
{:else}
  <div class="im-cover im-cover-empty" style="height: {height}px;">
    <span class="im-cover-placeholder">No cover</span>
  </div>
{/if}

<style>
  .im-cover {
    width: 100%;
    overflow: hidden;
    border-radius: 4px 4px 0 0;
    background: var(--background-secondary);
  }
  .im-cover-img {
    width: 100%;
    height: 100%;
    display: block;
  }
  .im-cover-empty {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .im-cover-placeholder {
    font-size: 12px;
    opacity: 0.3;
  }
</style>
