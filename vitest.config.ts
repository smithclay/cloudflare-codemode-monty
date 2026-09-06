import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A Monty pool spawns worker subprocesses; give checkout + spawn room on cold CI.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
