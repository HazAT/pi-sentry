import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["pi-extension/__tests__/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
  },
  fmt: {
    ignorePatterns: ["CHANGELOG.md", "README.md", "CLAUDE.md", "skills/**/*.md"],
  },
});
