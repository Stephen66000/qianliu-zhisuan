import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: [
      "src/App.pool043.test.tsx",
      "src/api/operating-bill-accounts.test.tsx",
      "src/api/operating-bills.pool043.test.tsx",
      "src/components/layout/Layout.pool043.test.tsx",
      "src/components/operating-bill/AccountShared.test.tsx",
      "src/components/operating-bill/OperatingBillShell.test.tsx",
      "src/pages/OperatingBill.test.tsx",
      "src/pages/OperatingBill.pool043-routing.test.tsx",
      "src/pages/OperatingBillAccounts.test.tsx",
    ],
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "coverage/pool043-web",
      include: [
        "src/App.tsx",
        "src/api/operating-bill-accounts.ts",
        "src/api/operating-bills.ts",
        "src/components/layout/AppLayout.tsx",
        "src/components/layout/Sidebar.tsx",
        "src/components/layout/Topbar.tsx",
        "src/components/operating-bill/AccountShared.tsx",
        "src/components/operating-bill/OperatingBillShell.tsx",
        "src/pages/OperatingBill.tsx",
        "src/pages/OperatingBillEmployees.tsx",
        "src/pages/OperatingBillEmployeeDetail.tsx",
        "src/pages/OperatingBillProjects.tsx",
      ],
      thresholds: { statements: 95, branches: 85, functions: 90, lines: 95 },
    },
  },
});
