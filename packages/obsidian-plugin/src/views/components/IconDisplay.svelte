<script lang="ts">
  interface Props {
    icon?: string;
    size?: number;
  }

  let { icon, size = 20 }: Props = $props();

  const isEmoji = $derived(icon ? /\p{Emoji}/u.test(icon) : false);
  const isUrl = $derived(icon ? icon.startsWith("http") : false);
</script>

{#if icon}
  <span class="im-icon" style="font-size: {size}px; width: {size}px; height: {size}px;">
    {#if isEmoji}
      {icon}
    {:else if isUrl}
      <img src={icon} alt="" width={size} height={size} class="im-icon-img" />
    {:else}
      <span class="im-icon-name">{icon}</span>
    {/if}
  </span>
{/if}

<style>
  .im-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    line-height: 1;
  }
  .im-icon-img {
    border-radius: 3px;
    object-fit: cover;
  }
  .im-icon-name {
    font-size: 0.7em;
    opacity: 0.6;
  }
</style>
