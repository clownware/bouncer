import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The CLI tests spawn the built binary, so a stale bundle silently tests old code.
    globalSetup: ["test/setup/build.ts"],
  },
});
