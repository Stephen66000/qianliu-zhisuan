import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/__tests__/upstream-error-evidence.test.ts",
      "src/__tests__/openai-compatible-caller.test.ts",
    ],
  },
});
