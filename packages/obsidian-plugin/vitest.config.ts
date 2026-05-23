import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    deps: {
      inline: ["@im-nobsidian/core"],
    },
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "tests/helpers/obsidian-stub.ts"),
    },
  },
});
