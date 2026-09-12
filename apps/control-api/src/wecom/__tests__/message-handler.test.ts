/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import {
  formatTokenVolume,
  formatPercentage,
  formatModelName,
  handleWecomMessage,
} from "../message-handler.js";

describe("WeCom Message Handler Units", () => {
  describe("formatTokenVolume (万/亿自适应进位与四舍五入)", () => {
    it("处理 0 或负数时返回 0.0 万", () => {
      expect(formatTokenVolume(0)).toBe("0.0 万");
      expect(formatTokenVolume("0", { showTokensWord: true })).toBe("0.0 万 Tokens");
      expect(formatTokenVolume(-100, { isDailyAvg: true })).toBe("0.0 万 /天");
    });

    it("小于 1 亿时以'万'为单位，保留 1 位小数四舍五入", () => {
      // 42,850 -> 4.285 -> 4.3 万 Tokens
      expect(formatTokenVolume(42850, { showTokensWord: true })).toBe("4.3 万 Tokens");
      // 328,500 -> 32.85 -> 32.9 万
      expect(formatTokenVolume("328500")).toBe("32.9 万");
      // 1,280,000 -> 128.0 万
      expect(formatTokenVolume(1280000)).toBe("128.0 万");
      // 日均用量 46,928 -> 4.7 万 /天
      expect(formatTokenVolume(46928, { isDailyAvg: true })).toBe("4.7 万 /天");
    });

    it("达到或超过 1 亿时升格为'亿'为单位，保留 1 位小数四舍五入", () => {
      // 125,400,000 -> 1.254 -> 1.3 亿 Tokens
      expect(formatTokenVolume(125400000, { showTokensWord: true })).toBe("1.3 亿 Tokens");
      // 200,000,000 -> 2.0 亿
      expect(formatTokenVolume("200000000")).toBe("2.0 亿");
      // 日均 105,000,000 -> 1.1 亿 /天
      expect(formatTokenVolume(105000000, { isDailyAvg: true })).toBe("1.1 亿 /天");
    });
  });

  describe("formatPercentage", () => {
    it("正确将小数比率格式化为百分比", () => {
      expect(formatPercentage("0.3333333333333333")).toBe("33.3%");
      expect(formatPercentage("0.162")).toBe("16.2%");
      expect(formatPercentage(0.742)).toBe("74.2%");
      expect(formatPercentage("74.2%")).toBe("74.2%");
      expect(formatPercentage("0")).toBe("0.0%");
    });
  });

  describe("formatModelName", () => {
    it("正确规整常见大模型名称", () => {
      expect(formatModelName("deepseek-v3")).toBe("DeepSeek-V3");
      expect(formatModelName("deepseek-chat")).toBe("DeepSeek-V3");
      expect(formatModelName("deepseek-r1")).toBe("DeepSeek-R1");
      expect(formatModelName("claude-3-5-sonnet-20241022")).toBe("Claude 3.5 Sonnet");
      expect(formatModelName("gpt-4o")).toBe("GPT-4o");
      expect(formatModelName("gpt-4o-mini")).toBe("GPT-4o-mini");
      expect(formatModelName("glm-4")).toBe("GLM-4");
    });
  });

  describe("handleWecomMessage", () => {
    const mockNow = new Date("2026-09-11T12:00:00+08:00");

    function createMockDb(options: {
      hasIdentity?: boolean;
      hasPrincipal?: boolean;
      isAdmin?: boolean;
      overviewResult?: any;
    }) {
      const {
        hasIdentity = true,
        hasPrincipal = true,
        isAdmin = false,
        overviewResult = {
          metrics: {
            activeSubjects: 8,
            requestCount: "1240",
            inputTokens: "2486000",
            outputTokens: "1356000",
            cacheTokens: "621000",
            realTokens: "3842000",
          },
          range: {
            from: "2026-09-07T00:00:00+08:00",
            to: "2026-09-11T23:59:59+08:00",
          },
          timezone: "Asia/Shanghai",
          ranking: [
            {
              subjectId: "principal-lisi",
              subjectName: "李四",
              departmentLabel: "架构组",
              realTokens: "1280000",
              inputTokens: "800000",
              outputTokens: "480000",
              cacheTokens: "200000",
              requestCount: "350",
              share: "0.33316",
            },
            {
              subjectId: "principal-zhangsan",
              subjectName: "张三",
              departmentLabel: "技术研发部",
              realTokens: "329000",
              inputTokens: "214000",
              outputTokens: "115000",
              cacheTokens: "82000",
              requestCount: "75",
              share: "0.08563",
            },
          ],
        },
      } = options;

      const mockDb: any = {
        selectFrom: (table: string) => {
          const chain: any = {
            innerJoin: () => chain,
            select: () => chain,
            where: () => chain,
            executeTakeFirst: async () => {
              if (table.includes("person_external_identity")) {
                if (!hasIdentity) return null;
                return {
                  enterprise_id: "test-ent",
                  person_id: "test-person",
                  person_name: "张三",
                  department_label: "技术研发部",
                  email: "zhangsan@example.com",
                };
              }
              if (table.includes("principal")) {
                if (!hasPrincipal) return null;
                return {
                  id: "principal-zhangsan",
                  name: "张三 (AI员工)",
                };
              }
              if (table.includes("admin_user")) {
                if (!isAdmin) return null;
                return { id: "admin-id" };
              }
              return null;
            },
          };
          return chain;
        },
      };

      return { mockDb, overviewResult };
    }

    it("非用量咨询文本（如问候）返回标准引导菜单", async () => {
      const { mockDb } = createMockDb({});
      const reply = await handleWecomMessage(mockDb, "user_001", "你好，请问你是？", mockNow);
      expect(reply).toContain("我是【仟流智算】AI 助手");
      expect(reply).toContain("今天我用了多少token");
      expect(reply).toContain("本周用量");
    });

    it("企微账号未关联人员档案时返回未关联提示", async () => {
      const { mockDb } = createMockDb({ hasIdentity: false });
      const reply = await handleWecomMessage(mockDb, "unlinked_user", "本周用量", mockNow);
      expect(reply).toContain("未关联身份");
      expect(reply).toContain("未找到您企业微信账号（unlinked_user）");
    });

    it("人员档案已同步但未开通 AI 主体时返回主体未开通提示", async () => {
      const { mockDb } = createMockDb({ hasIdentity: true, hasPrincipal: false });
      const reply = await handleWecomMessage(mockDb, "no_principal_user", "本周用量", mockNow);
      expect(reply).toContain("主体未开通");
      expect(reply).toContain("尚未开通 AI 员工使用主体");
    });

    it("员工查询个人本周用量时，正确应用'万'单位并生成排位激励小贴士", async () => {
      const { mockDb, overviewResult } = createMockDb({
        hasIdentity: true,
        hasPrincipal: true,
        isAdmin: false,
      });

      // Mock UsageOverviewRepository
      const { UsageOverviewRepository } = await import("@qianliu/database");
      const spy = vi.spyOn(UsageOverviewRepository.prototype, "getOverview").mockResolvedValue(overviewResult);

      const reply = await handleWecomMessage(mockDb, "user_zhangsan", "本周用量", mockNow);

      expect(reply).toContain("【仟流智算 · 个人用量统计】");
      expect(reply).toContain("姓名：张三（技术研发部）");
      // 329,000 -> 32.9 万 Tokens
      expect(reply).toContain("32.9 万 Tokens");
      expect(reply).toContain("输入消耗：21.4 万");
      expect(reply).toContain("输出消耗：11.5 万");
      expect(reply).toContain("缓存命中：8.2 万 Tokens");
      expect(reply).toContain("发起调用次数：75 次");
      // 排位计算：第 2 名 / 共 2 人 (前 100% 或超越半数同事)
      expect(reply).toContain("团队表现：");

      spy.mockRestore();
    });

    it("员工登顶第一名时，团队表现显示流动红旗荣誉激励", async () => {
      const top1Overview = {
        metrics: {
          activeSubjects: 5,
          requestCount: "1240",
          inputTokens: "2486000",
          outputTokens: "1356000",
          cacheTokens: "621000",
          realTokens: "3842000",
        },
        range: {
          from: "2026-09-07T00:00:00+08:00",
          to: "2026-09-11T23:59:59+08:00",
        },
        timezone: "Asia/Shanghai",
        ranking: [
          {
            subjectId: "principal-zhangsan",
            subjectName: "张三",
            departmentLabel: "技术研发部",
            realTokens: "1280000",
            inputTokens: "800000",
            outputTokens: "480000",
            cacheTokens: "200000",
            requestCount: "350",
            share: "0.33316",
          },
        ],
      };

      const { mockDb } = createMockDb({});
      const { UsageOverviewRepository } = await import("@qianliu/database");
      const spy = vi.spyOn(UsageOverviewRepository.prototype, "getOverview").mockResolvedValue(top1Overview as any);

      const reply = await handleWecomMessage(mockDb, "user_zhangsan", "今天消耗", mockNow);

      expect(reply).toContain("荣登团队第 1 名");
      expect(reply).toContain("断层领跑！继续保持卓越节奏！");
      expect(reply).toContain("128.0 万 Tokens");

      spy.mockRestore();
    });

    it("普通员工尝试查询全员用量时，自动降级为个人数据并展示友好注记", async () => {
      const { mockDb, overviewResult } = createMockDb({ isAdmin: false });
      const { UsageOverviewRepository } = await import("@qianliu/database");
      const spy = vi.spyOn(UsageOverviewRepository.prototype, "getOverview").mockResolvedValue(overviewResult);

      const reply = await handleWecomMessage(mockDb, "user_zhangsan", "团队今天用了多少token", mockNow);

      expect(reply).toContain("您当前为员工主体，已为您展示个人用量数据");
      expect(reply).toContain("个人用量统计");

      spy.mockRestore();
    });

    it("管理员查询全员用量时，展示全员数据与 Top 5 万/亿换算与百分比榜单", async () => {
      const { mockDb, overviewResult } = createMockDb({ isAdmin: true });
      const { UsageOverviewRepository } = await import("@qianliu/database");
      const spy = vi.spyOn(UsageOverviewRepository.prototype, "getOverview").mockResolvedValue(overviewResult);

      const reply = await handleWecomMessage(mockDb, "admin_user", "全员本周用量", mockNow);

      expect(reply).toContain("【仟流智算 · 全员用量统计】");
      // 3,842,000 -> 384.2 万 Tokens
      expect(reply).toContain("全员总消耗：384.2 万 Tokens");
      expect(reply).toContain("输入消耗：248.6 万");
      expect(reply).toContain("输出消耗：135.6 万");
      expect(reply).toContain("发起调用次数：1,240 次");
      expect(reply).toContain("活跃员工数：8 人");
      // Top 5
      expect(reply).toContain("【成员消耗 Top 5】");
      expect(reply).toContain("1. 李四 (架构组): 128.0 万 (33.3%)");
      expect(reply).toContain("2. 张三 (技术研发部): 32.9 万 (8.6%)");

      spy.mockRestore();
    });
  });
});
