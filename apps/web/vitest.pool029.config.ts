import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: [
      "src/api/employee-model-rules.test.tsx",
      "src/pages/EmployeeModelRules.test.tsx",
      "src/components/layout/Sidebar.test.tsx",
    ],
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "coverage/pool029-web",
      include: [
        "src/pages/EmployeeModelRules.tsx",
        "src/api/employee-model-rules.ts",
        "src/components/layout/Sidebar.tsx",
      ],
      thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 },
    },
  },
});
