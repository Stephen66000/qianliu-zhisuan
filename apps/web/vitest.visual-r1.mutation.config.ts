/** R1 精准变异只运行资金确认回归；沿用正式组件测试的插件、环境与setup。 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "./vitest.config";
export default defineConfig({
  ...base,
  root: fileURLToPath(new URL("./", import.meta.url)),
  test: { ...base.test, include: ["src/components/resources/ProviderFinancePanel*.test.tsx"] },
});
