<script lang="ts">
  import { getNotionColor, getNotionBgColor } from "@im-nobsidian/core";

  interface Props {
    value: string;
    color?: string;
  }

  let { value, color = "default" }: Props = $props();
</script>

<span
  class="im-property-badge"
  style="color: {getNotionColor(color)}; background: {getNotionBgColor(color)};"
>
  {value}
</span>

<style>
  .im-property-badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 4px;
    font-size: 12px;
    line-height: 20px;
    white-space: nowrap;
  }
</style>
