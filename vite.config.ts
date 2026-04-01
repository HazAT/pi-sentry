import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["pi-extension/__tests__/**/*.test.ts"],
  },
  fmt: {
    ignorePatterns: ["CHANGELOG.md", "README.md", "CLAUDE.md", "skills/**/*.md"],
  },
});
